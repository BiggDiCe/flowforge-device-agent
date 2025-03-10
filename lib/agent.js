const { existsSync } = require('fs')
const fs = require('fs/promises')
const path = require('path')
const httpClient = require('./http')
const mqttClient = require('./mqtt')
const launcher = require('./launcher.js')
const { info, warn, debug } = require('./log')

const PROJECT_FILE = 'flowforge-project.json'

class Agent {
    constructor (config) {
        this.config = config
        this.startTime = Date.now()
        this.projectFilePath = path.join(this.config.dir, PROJECT_FILE)
        this.httpClient = httpClient.HTTPClient(this, this.config)
        this.currentSnapshot = null
        this.currentSettings = null
        this.currentProject = null
        this.launcher = null
        this.updating = false
        this.queuedUpdate = null
        // Track the local state of the agent. Start in 'unknown' state so
        // that the first MQTT checkin will trigger a response
        this.currentState = 'unknown'
    }

    async loadProject () {
        if (existsSync(this.projectFilePath)) {
            try {
                const config = JSON.parse(await fs.readFile(this.projectFilePath, 'utf8'))
                if (config.id) {
                    // Old format
                    this.currentSnapshot = config
                    if (this.currentSnapshot.device) {
                        this.currentSettings = this.currentSnapshot.device
                        delete this.currentSnapshot.device
                    }
                    this.currentProject = null
                } else {
                    // New format
                    this.currentProject = config.project || null
                    this.currentSnapshot = config.snapshot || null
                    this.currentSettings = config.settings || null
                }
                info(`Project: ${this.currentProject || 'unknown'}`)
                info(`Snapshot: ${this.currentSnapshot?.id || 'none'}`)
                info(`Settings: ${this.currentSettings?.hash || 'none'}`)
            } catch (err) {
                warn(`Invalid project file: ${this.projectFilePath}`)
            }
        }
    }

    async saveProject () {
        await fs.writeFile(this.projectFilePath, JSON.stringify({
            project: this.currentProject,
            snapshot: this.currentSnapshot,
            settings: this.currentSettings
        }))
    }

    async start () {
        await this.loadProject()

        if (this.config.brokerURL) {
            // We have been provided a broker URL to use
            this.mqttClient = mqttClient.MQTTClient(this, this.config)
            this.mqttClient.start()
            this.mqttClient.setProject(this.currentProject)
            //
        } else {
            this.currentState = 'stopped'
            // Fallback to HTTP polling
            this.httpClient.startPolling()
        }
    }

    async stop () {
        this.httpClient.stopPolling()
        if (this.mqttClient) {
            this.mqttClient.stop()
        }
        if (this.launcher) {
            await this.launcher.stop()
        }
    }

    getState () {
        if (this.updating) {
            return null
        }
        return {
            project: this.currentProject || null,
            snapshot: this.currentSnapshot?.id || null,
            settings: this.currentSettings?.hash || null,
            state: this.launcher?.state || this.currentState,
            health: {
                uptime: Math.floor((Date.now() - this.startTime) / 1000),
                snapshotRestartCount: this.launcher?.restartCount || 0
            }
        }
    }

    async setState (newState) {
        debug(newState)
        if (this.updating) {
            this.queuedUpdate = newState
            return
        }
        this.updating = true
        if (newState === null) {
            // The agent should not be running (bad credentials/device details)
            // Wipe the local configuration
            this.stop()
            this.currentSnapshot = null
            this.currentProject = null
            this.currentSettings = null
            await this.saveProject()
            this.currentState = 'stopped'
            this.updating = false
        } else if (newState.project === null) {
            if (this.currentProject) {
                debug('Removed from project')
            }
            // Device unassigned from project
            if (this.mqttClient) {
                this.mqttClient.setProject(null)
            }
            // Stop the project if running - with clean flag
            if (this.launcher) {
                await this.launcher.stop(true)
                this.launcher = undefined
            }
            this.currentProject = null
            this.currentSnapshot = null
            await this.saveProject()
            this.currentState = 'stopped'
            this.updating = false
        } else if (newState.snapshot === null) {
            // Snapshot removed, but project still active
            if (this.currentSnapshot) {
                debug('Active snapshot removed')
                this.currentSnapshot = null
                await this.saveProject()
            }
            if (Object.hasOwn(newState, 'project')) {
                if (newState.project !== this.currentProject) {
                    this.currentProject = newState.project
                    await this.saveProject()
                    if (this.mqttClient) {
                        this.mqttClient.setProject(this.currentProject)
                    }
                }
            }
            if (this.launcher) {
                await this.launcher.stop(true)
                this.launcher = undefined
            }
            this.currentState = 'stopped'
            this.updating = false
        } else {
            // Check if any updates are needed
            let updateSnapshot = false
            let updateSettings = false
            if (Object.hasOwn(newState, 'project') && (!this.currentSnapshot || newState.project !== this.currentProject)) {
                info('New project assigned')
                this.currentProject = newState.project
                // Update everything
                updateSnapshot = true
                updateSettings = true
            } else {
                if (Object.hasOwn(newState, 'snapshot') && (!this.currentSnapshot || newState.snapshot !== this.currentSnapshot.id)) {
                    info('New snapshot available')
                    updateSnapshot = true
                }
                if (Object.hasOwn(newState, 'settings') && (!this.currentSettings || newState.settings !== this.currentSettings?.hash)) {
                    info('New settings available')
                    updateSettings = true
                }
            }
            if (!updateSnapshot && !updateSettings) {
                // Nothing to update.
                if (!this.launcher && this.currentSnapshot) {
                    // Ensure the launcher is running using the currentSnapshot
                    this.launcher = launcher.Launcher(this.config, this.currentProject, this.currentSnapshot, this.currentSettings)
                    await this.launcher.start()
                    if (this.mqttClient) {
                        this.mqttClient.setProject(this.currentProject)
                        this.mqttClient.checkIn()
                    }
                }
                this.currentState = 'stopped'
                this.updating = false
            } else {
                // An update is needed. Stop the launcher if currently running
                this.currentState = 'updating'
                if (this.launcher) {
                    info('Stopping current snapshot')
                    await this.launcher.stop()
                    this.launcher = undefined
                }

                if (updateSnapshot) {
                    this.currentSnapshot = await this.httpClient.getSnapshot()
                }
                if (updateSettings) {
                    this.currentSettings = await this.httpClient.getSettings()
                }
                if (this.currentSnapshot.id) {
                    try {
                        // There is a new snapshot/settings to use
                        info(`Project: ${this.currentProject || 'unknown'}`)
                        info(`Snapshot: ${this.currentSnapshot.id}`)
                        info(`Settings: ${this.currentSettings?.hash || 'none'}`)
                        await this.saveProject()
                        this.launcher = launcher.Launcher(this.config, this.currentProject, this.currentSnapshot, this.currentSettings)
                        await this.launcher.writeConfiguration()
                        await this.launcher.start()
                        if (this.mqttClient) {
                            this.mqttClient.setProject(this.currentProject)
                            this.mqttClient.checkIn()
                        }
                    } catch (err) {
                        warn(`Error whilst starting project: ${err.toString()}`)
                        if (this.launcher) {
                            await this.launcher.stop(true)
                        }
                        this.launcher = undefined
                    }
                }
            }
        }
        this.currentState = this.launcher ? 'running' : 'stopped'
        this.updating = false
        if (this.queuedUpdate) {
            const update = this.queuedUpdate
            this.queuedUpdate = null
            this.setState(update)
        }
    }
}

module.exports = {
    Agent: (config) => new Agent(config)
}
