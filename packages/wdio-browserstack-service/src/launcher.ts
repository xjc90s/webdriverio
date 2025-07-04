import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify, format } from 'node:util'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import os from 'node:os'
import { SevereServiceError } from 'webdriverio'

import * as BrowserstackLocalLauncher from 'browserstack-local'

import { getProductMap } from './testHub/utils.js'
import TestOpsConfig from './testOps/testOpsConfig.js'

import type { Capabilities, Services, Options } from '@wdio/types'

import { startPercy, stopPercy, getBestPlatformForPercySnapshot } from './Percy/PercyHelper.js'

import type { BrowserstackConfig, BrowserstackOptions, App, AppConfig, AppUploadResponse, UserConfig } from './types.js'
import {
    BSTACK_SERVICE_VERSION,
    NOT_ALLOWED_KEYS_IN_CAPS, PERF_MEASUREMENT_ENV, RERUN_ENV, RERUN_TESTS_ENV,
    BROWSERSTACK_TESTHUB_UUID,
    VALID_APP_EXTENSION,
    BROWSERSTACK_PERCY,
    BROWSERSTACK_OBSERVABILITY
} from './constants.js'
import {
    launchTestSession,
    shouldAddServiceVersion,
    stopBuildUpstream,
    getCiInfo,
    isBStackSession,
    isUndefined,
    isAccessibilityAutomationSession,
    isTrue,
    getBrowserStackUser,
    getBrowserStackKey,
    uploadLogs,
    ObjectsAreEqual, getBasicAuthHeader,
    isValidCapsForHealing,
    getBooleanValueFromString,
    validateCapsWithNonBstackA11y,
    mergeChromeOptions
} from './util.js'
import CrashReporter from './crash-reporter.js'
import { BStackLogger } from './bstackLogger.js'
import { PercyLogger } from './Percy/PercyLogger.js'
import type Percy from './Percy/Percy.js'
import BrowserStackConfig from './config.js'
import { setupExitHandlers } from './exitHandler.js'
import { sendFinish, sendStart } from './instrumentation/funnelInstrumentation.js'
import AiHandler from './ai-handler.js'
import PerformanceTester from './instrumentation/performance/performance-tester.js'
import * as PERFORMANCE_SDK_EVENTS from './instrumentation/performance/constants.js'
import accessibilityScripts from './scripts/accessibility-scripts.js'
import { _fetch as fetch } from './fetchWrapper.js'

type BrowserstackLocal = BrowserstackLocalLauncher.Local & {
    pid?: number
    stop(callback: (err?: Error) => void): void
}

export default class BrowserstackLauncherService implements Services.ServiceInstance {
    browserstackLocal?: BrowserstackLocal
    private _buildName?: string
    private _projectName?: string
    private _buildTag?: string
    private _buildIdentifier?: string
    private _accessibilityAutomation?: boolean | null = null
    private _percy?: Percy
    private _percyBestPlatformCaps?: WebdriverIO.Capabilities
    private readonly browserStackConfig: BrowserStackConfig

    constructor (
        private _options: BrowserstackConfig & BrowserstackOptions,
        capabilities: Capabilities.TestrunnerCapabilities,
        private _config: Options.Testrunner
    ) {
        BStackLogger.clearLogFile()
        PercyLogger.clearLogFile()
        setupExitHandlers()
        // added to maintain backward compatibility with webdriverIO v5
        if (!this._config) {
            this._config = _options
        }
        this.browserStackConfig = BrowserStackConfig.getInstance(_options, _config)
        if (Array.isArray(capabilities)) {
            capabilities
                .flatMap((c) => {
                    if ('alwaysMatch' in c) {
                        return c.alwaysMatch as WebdriverIO.Capabilities
                    }

                    if (Object.values(c).length > 0 && Object.values(c).every(c => typeof c === 'object' && c.capabilities)) {
                        return Object.values(c).map((o) => o.capabilities) as WebdriverIO.Capabilities[]
                    }
                    return c as WebdriverIO.Capabilities
                })
                .forEach((capability: WebdriverIO.Capabilities) => {
                    if (!capability['bstack:options']) {
                        // Skipping adding of service version if session is not of browserstack
                        if (isBStackSession(this._config)) {
                            const extensionCaps = Object.keys(capability).filter((cap) => cap.includes(':'))
                            if (extensionCaps.length) {
                                capability['bstack:options'] = { wdioService: BSTACK_SERVICE_VERSION }
                                if (!isUndefined(capability['browserstack.accessibility'])) {
                                    this._accessibilityAutomation ||= isTrue(capability['browserstack.accessibility'])
                                } else if (isTrue(this._options.accessibility)) {
                                    capability['bstack:options'].accessibility = true
                                }
                            } else if (shouldAddServiceVersion(this._config, this._options.testObservability)) {
                                capability['browserstack.wdioService'] = BSTACK_SERVICE_VERSION
                            }
                        }

                        // Need this details for sending data to Observability
                        this._buildIdentifier = capability['browserstack.buildIdentifier']?.toString()
                        // @ts-expect-error ToDo: fix invalid cap
                        this._buildName = capability.build?.toString()
                    } else {
                        capability['bstack:options'].wdioService = BSTACK_SERVICE_VERSION
                        this._buildName = capability['bstack:options'].buildName
                        this._projectName = capability['bstack:options'].projectName
                        this._buildTag = capability['bstack:options'].buildTag
                        this._buildIdentifier = capability['bstack:options'].buildIdentifier

                        if (!isUndefined(capability['bstack:options'].accessibility)) {
                            this._accessibilityAutomation ||= isTrue(capability['bstack:options'].accessibility)
                        } else if (isTrue(this._options.accessibility)) {
                            capability['bstack:options'].accessibility = (isTrue(this._options.accessibility))
                        }
                    }
                })
        } else if (typeof capabilities === 'object') {
            Object.entries(capabilities as Capabilities.RequestedMultiremoteCapabilities).forEach(([, caps]) => {
                if (!(caps.capabilities as WebdriverIO.Capabilities)['bstack:options']) {
                    if (isBStackSession(this._config)) {
                        const extensionCaps = Object.keys(caps.capabilities).filter((cap) => cap.includes(':'))
                        if (extensionCaps.length) {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { wdioService: BSTACK_SERVICE_VERSION }
                            if (!isUndefined((caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibility'])) {
                                this._accessibilityAutomation ||= isTrue((caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibility'])
                            } else if (isTrue(this._options.accessibility)) {
                                (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { wdioService: BSTACK_SERVICE_VERSION, accessibility: (isTrue(this._options.accessibility)) }
                            }
                        } else if (shouldAddServiceVersion(this._config, this._options.testObservability)) {
                            (caps.capabilities as WebdriverIO.Capabilities)['browserstack.wdioService'] = BSTACK_SERVICE_VERSION
                        }
                    }
                    this._buildIdentifier = (caps.capabilities as WebdriverIO.Capabilities)['browserstack.buildIdentifier']
                } else {
                    const bstackOptions = (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']
                    bstackOptions!.wdioService = BSTACK_SERVICE_VERSION
                    this._buildName = bstackOptions!.buildName
                    this._projectName = bstackOptions!.projectName
                    this._buildTag = bstackOptions!.buildTag
                    this._buildIdentifier = bstackOptions!.buildIdentifier
                    if (!isUndefined(bstackOptions!.accessibility)) {
                        this._accessibilityAutomation ||= isTrue(bstackOptions!.accessibility)
                    } else if (isTrue(this._options.accessibility)) {
                        bstackOptions!.accessibility = isTrue(this._options.accessibility)
                    }
                }
            })
        }

        this.browserStackConfig.buildIdentifier = this._buildIdentifier
        this.browserStackConfig.buildName = this._buildName

        PerformanceTester.startMonitoring('performance-report-launcher.csv')

        if (!isUndefined(this._options.accessibility)) {
            this._accessibilityAutomation ||= isTrue(this._options.accessibility)
        }
        this._options.accessibility = this._accessibilityAutomation as boolean

        // by default observability will be true unless specified as false
        this._options.testObservability = this._options.testObservability !== false

        if (this._options.testObservability
            &&
            // update files to run if it's a rerun
            process.env[RERUN_ENV] && process.env[RERUN_TESTS_ENV]
        ) {
            this._config.specs = process.env[RERUN_TESTS_ENV].split(',')
        }
        try {
            CrashReporter.setConfigDetails(this._config, capabilities, this._options)
        } catch (error: unknown) {
            BStackLogger.error(`[Crash_Report_Upload] Config processing failed due to ${error}`)
        }
    }

    @PerformanceTester.Measure(PERFORMANCE_SDK_EVENTS.EVENTS.SDK_SETUP)
    async onWorkerStart (cid: string, caps: WebdriverIO.Capabilities) {
        try {
            if (this._options.percy && this._percyBestPlatformCaps) {
                const isThisBestPercyPlatform = ObjectsAreEqual(caps, this._percyBestPlatformCaps)
                if (isThisBestPercyPlatform) {
                    process.env.BEST_PLATFORM_CID = cid
                }
            }
        } catch (err) {
            PercyLogger.error(`Error while setting best platform for Percy snapshot at worker start ${err}`)
        }
    }

    @PerformanceTester.Measure(PERFORMANCE_SDK_EVENTS.EVENTS.SDK_PRE_TEST)
    async onPrepare (config: Options.Testrunner, capabilities: Capabilities.TestrunnerCapabilities | WebdriverIO.Capabilities) {
        // Send Funnel start request
        await sendStart(this.browserStackConfig)

        // Setting up healing for those sessions where we don't add the service version capability as it indicates that the session is not being run on BrowserStack
        if (!shouldAddServiceVersion(this._config, this._options.testObservability, capabilities as Capabilities.BrowserStackCapabilities)) {
            try {
                if ((capabilities as Capabilities.BrowserStackCapabilities).browserName) {
                    capabilities = await AiHandler.setup(this._config, this.browserStackConfig, this._options, capabilities as WebdriverIO.Capabilities, false)
                } else if ( Array.isArray(capabilities)){

                    for (let i = 0; i < capabilities.length; i++) {
                        if ((capabilities[i] as Capabilities.BrowserStackCapabilities).browserName) {
                            capabilities[i] = await AiHandler.setup(this._config, this.browserStackConfig, this._options, capabilities[i] as WebdriverIO.Capabilities, false)
                        }
                    }

                } else if (isValidCapsForHealing(capabilities)) {
                    // setting up healing in case capabilities.xyz.capabilities.browserName where xyz can be anything:
                    capabilities = await AiHandler.setup(this._config, this.browserStackConfig, this._options, capabilities, true)
                }
            } catch (err) {
                if (this._options.selfHeal === true) {
                    BStackLogger.warn(`Error while setting up Browserstack healing Extension ${err}. Disabling healing for this session.`)
                }
            }
        }

        /**
         * Upload app to BrowserStack if valid file path to app is given.
         * Update app value of capability directly if app_url, custom_id, shareable_id is given
         */
        if (!this._options.app) {
            BStackLogger.debug('app is not defined in browserstack-service config, skipping ...')
        } else {
            let app: App = {}
            const appConfig: AppConfig | string = this._options.app

            try {
                app = await this._validateApp(appConfig)
            } catch (error: unknown){
                throw new SevereServiceError((error as Error).message)
            }

            if (VALID_APP_EXTENSION.includes(path.extname(app.app!))){
                if (fs.existsSync(app.app!)) {
                    const data: AppUploadResponse = await this._uploadApp(app)
                    BStackLogger.info(`app upload completed: ${JSON.stringify(data)}`)
                    app.app = data.app_url
                } else if (app.customId){
                    app.app = app.customId
                } else {
                    throw new SevereServiceError(`[Invalid app path] app path ${app.app} is not correct, Provide correct path to app under test`)
                }
            }

            BStackLogger.info(`Using app: ${app.app}`)
            this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'app', app.app)
        }

        /**
         * buildIdentifier in service options will take precedence over specified in capabilities
        */
        if (this._options.buildIdentifier) {
            this._buildIdentifier = this._options.buildIdentifier
            this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'buildIdentifier', this._buildIdentifier)
        }

        /**
         * evaluate buildIdentifier in case unique execution identifiers are present
         * e.g., ${BUILD_NUMBER} and ${DATE_TIME}
        */
        this._handleBuildIdentifier(capabilities as Capabilities.TestrunnerCapabilities)

        // remove accessibilityOptions from the capabilities if present
        this._updateObjectTypeCaps(capabilities as Capabilities.TestrunnerCapabilities, 'accessibilityOptions')

        const shouldSetupPercy = this._options.percy || (isUndefined(this._options.percy) && this._options.app)

        let buildStartResponse = null
        if (this._options.testObservability || this._accessibilityAutomation || shouldSetupPercy) {
            BStackLogger.debug('Sending launch start event')

            buildStartResponse = await launchTestSession(this._options, this._config, {
                projectName: this._projectName,
                buildName: this._buildName,
                buildTag: this._buildTag,
                bstackServiceVersion: BSTACK_SERVICE_VERSION,
                buildIdentifier: this._buildIdentifier
            }, this.browserStackConfig, this._accessibilityAutomation)
        }

        //added checks for Accessibility running on non-bstack infra
        if (isAccessibilityAutomationSession(this._accessibilityAutomation) && (process.env.BROWSERSTACK_TURBOSCALE || !shouldAddServiceVersion(this._config, this._options.testObservability))){
            const overrideOptions: Partial<Capabilities.ChromeOptions> = accessibilityScripts.ChromeExtension
            this._updateObjectTypeCaps(capabilities, 'goog:chromeOptions', overrideOptions)
        }

        if (buildStartResponse?.accessibility) {
            if (this._accessibilityAutomation === null) {
                this.browserStackConfig.accessibility = buildStartResponse.accessibility.success as boolean
                this._accessibilityAutomation = buildStartResponse.accessibility.success as boolean
                this._options.accessibility = buildStartResponse.accessibility.success as boolean
                if (buildStartResponse.accessibility.success === true) {
                    this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'accessibility', 'true')
                }
            }
        }

        this.browserStackConfig.accessibility = this._accessibilityAutomation as boolean

        if (this._accessibilityAutomation && this._options.accessibilityOptions) {
            const filteredOpts = Object.keys(this._options.accessibilityOptions)
                .filter(key => !NOT_ALLOWED_KEYS_IN_CAPS.includes(key))
                .reduce((opts, key) => {
                    return {
                        ...opts,
                        [key]: this._options.accessibilityOptions?.[key]
                    }
                }, {})

            this._updateObjectTypeCaps(capabilities as Capabilities.TestrunnerCapabilities, 'accessibilityOptions', filteredOpts)
        } else if (isAccessibilityAutomationSession(this._accessibilityAutomation)) {
            this._updateObjectTypeCaps(capabilities as Capabilities.TestrunnerCapabilities, 'accessibilityOptions', {})
        }

        if (shouldSetupPercy) {
            try {
                const bestPlatformPercyCaps = getBestPlatformForPercySnapshot(capabilities as Capabilities.TestrunnerCapabilities)
                this._percyBestPlatformCaps = bestPlatformPercyCaps as WebdriverIO.Capabilities
                process.env[BROWSERSTACK_PERCY] = 'false'
                await this.setupPercy(this._options, this._config, {
                    projectName: this._projectName
                })
                this._updateBrowserStackPercyConfig()
            } catch (err) {
                PercyLogger.error(`Error while setting up Percy ${err}`)
            }
        }

        this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'testhubBuildUuid')
        this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'buildProductMap')

        if (!this._options.browserstackLocal) {
            return BStackLogger.info('browserstackLocal is not enabled - skipping...')
        }

        const opts = {
            key: this._config.key,
            ...this._options.opts
        }

        this.browserstackLocal = new BrowserstackLocalLauncher.Local()

        this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'local')
        if (opts.localIdentifier) {
            this._updateCaps(capabilities as Capabilities.TestrunnerCapabilities, 'localIdentifier', opts.localIdentifier)
        }

        /**
         * measure BrowserStack tunnel boot time
         */
        const obs = new PerformanceObserver((list) => {
            const entry = list.getEntries()[0]
            BStackLogger.info(`Browserstack Local successfully started after ${entry.duration}ms`)
        })

        obs.observe({ entryTypes: ['measure'] })

        let timer: NodeJS.Timeout
        performance.mark('tbTunnelStart')
        PerformanceTester.start(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_START)
        return Promise.race([
            promisify(this.browserstackLocal.start.bind(this.browserstackLocal))(opts),
            new Promise((resolve, reject) => {
                /* istanbul ignore next */
                timer = setTimeout(function () {
                    reject('Browserstack Local failed to start within 60 seconds!')
                }, 60000)
            })]
        ).then(function (result) {
            clearTimeout(timer)
            performance.mark('tbTunnelEnd')
            PerformanceTester.end(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_START)
            performance.measure('bootTime', 'tbTunnelStart', 'tbTunnelEnd')
            return Promise.resolve(result)
        }, function (err) {
            PerformanceTester.end(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_START, false, err)
            clearTimeout(timer)
            return Promise.reject(err)
        })
    }

    @PerformanceTester.Measure(PERFORMANCE_SDK_EVENTS.EVENTS.SDK_CLEANUP)
    async onComplete () {
        BStackLogger.debug('Inside OnComplete hook..')

        BStackLogger.debug('Sending stop launch event')
        await stopBuildUpstream()
        if (process.env[BROWSERSTACK_OBSERVABILITY] && process.env[BROWSERSTACK_TESTHUB_UUID]) {
            console.log(`\nVisit https://observability.browserstack.com/builds/${process.env[BROWSERSTACK_TESTHUB_UUID]} to view build report, insights, and many more debugging information all at one place!\n`)
        }
        this.browserStackConfig.testObservability.buildStopped = true

        await PerformanceTester.stopAndGenerate('performance-launcher.html')
        if (process.env[PERF_MEASUREMENT_ENV]) {
            PerformanceTester.calculateTimes(['launchTestSession', 'stopBuildUpstream'])

            if (!process.env.START_TIME) {
                return
            }
            const duration = (new Date()).getTime() - (new Date(process.env.START_TIME)).getTime()
            BStackLogger.info(`Total duration is ${duration / 1000} s`)
        }

        BStackLogger.info(`BrowserStack service run ended for id: ${this.browserStackConfig?.sdkRunID} testhub id: ${TestOpsConfig.getInstance()?.buildHashedId}`)
        await sendFinish(this.browserStackConfig)
        try {
            await this._uploadServiceLogs()
        } catch (error) {
            BStackLogger.debug(`Failed to upload BrowserStack WDIO Service logs ${error}`)
        }

        BStackLogger.clearLogger()

        if (this._options.percy) {
            await this.stopPercy()
            PercyLogger.clearLogger()
        }

        if (!this.browserstackLocal || !this.browserstackLocal.isRunning()) {
            return
        }

        if (this._options.forcedStop) {
            return process.kill(this.browserstackLocal.pid as number)
        }

        let timer: NodeJS.Timeout
        PerformanceTester.start(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_STOP)
        return Promise.race([
            new Promise<void>((resolve, reject) => {
                this.browserstackLocal?.stop((err: Error) => {
                    if (err) {
                        return reject(err)
                    }
                    resolve()
                })
            }),
            new Promise((resolve, reject) => {
                /* istanbul ignore next */
                timer = setTimeout(
                    () => reject(new Error('Browserstack Local failed to stop within 60 seconds!')),
                    60000
                )
            })]
        ).then(function (result) {
            PerformanceTester.end(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_STOP)
            clearTimeout(timer)
            return Promise.resolve(result)
        }, function (err) {
            PerformanceTester.end(PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.LOCAL_STOP, false, err)
            clearTimeout(timer)
            return Promise.reject(err)
        })
    }

    async setupPercy(options: BrowserstackConfig & Options.Testrunner, config: Options.Testrunner, bsConfig: UserConfig) {

        if (this._percy?.isRunning()) {
            process.env[BROWSERSTACK_PERCY] = 'true'
            return
        }
        try {
            this._percy = await startPercy(options, config, bsConfig)
            if (!this._percy || (typeof this._percy === 'object' && Object.keys(this._percy).length === 0)) {
                throw new Error('Could not start percy, check percy logs for info.')
            }
            PercyLogger.info('Percy started successfully')
            process.env[BROWSERSTACK_PERCY] = 'true'
            let signal = 0
            const handler = async () => {
                signal++
                if (signal === 1) {
                    await this.stopPercy()
                }
            }
            process.on('beforeExit', handler)
            process.on('SIGINT', handler)
            process.on('SIGTERM', handler)
        } catch (err) {
            PercyLogger.debug(`Error in percy setup ${format(err)}`)
            process.env[BROWSERSTACK_PERCY] = 'false'
        }
    }

    async stopPercy() {
        if (!this._percy || !this._percy.isRunning()) {
            return
        }
        try {
            await stopPercy(this._percy)
            PercyLogger.info('Percy stopped')
        } catch (err) {
            PercyLogger.error('Error occured while stopping percy : ' + err)
        }
    }

    @PerformanceTester.Measure(PERFORMANCE_SDK_EVENTS.APP_AUTOMATE_EVENTS.APP_UPLOAD)
    async _uploadApp(app:App): Promise<AppUploadResponse> {
        BStackLogger.info(`uploading app ${app.app} ${app.customId? `and custom_id: ${app.customId}` : ''} to browserstack`)

        const form = new FormData()
        if (app.app) {
            const fileName = path.basename(app.app)
            const fileBlob = new Blob([await readFile(app.app)])
            form.append('file', fileBlob, fileName)
        }
        if (app.customId) {
            form.append('custom_id', app.customId)
        }

        const headers: Record<string, string> = {
            Authorization: getBasicAuthHeader(this._config.user as string, this._config.key as string),
        }

        const res = await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
            method: 'POST',
            body: form,
            headers
        })

        if (!res.ok) {
            throw new SevereServiceError(`app upload failed ${res.body}`)
        }
        return await res.json() as AppUploadResponse
    }

    /**
     * @param  {String | AppConfig}  appConfig    <string>: should be "app file path" or "app_url" or "custom_id" or "shareable_id".
     *                                            <object>: only "path" and "custom_id" should coexist as multiple properties.
     */
    async _validateApp (appConfig: AppConfig | string): Promise<App> {
        const app: App = {}

        if (typeof appConfig === 'string'){
            app.app = appConfig
        } else if (typeof appConfig === 'object' && Object.keys(appConfig).length) {
            if (Object.keys(appConfig).length > 2 || (Object.keys(appConfig).length === 2 && (!appConfig.path || !appConfig.custom_id))) {
                throw new SevereServiceError(`keys ${Object.keys(appConfig)} can't co-exist as app values, use any one property from
                            {id<string>, path<string>, custom_id<string>, shareable_id<string>}, only "path" and "custom_id" can co-exist.`)
            }

            app.app = appConfig.id || appConfig.path || appConfig.custom_id || appConfig.shareable_id
            app.customId = appConfig.custom_id
        } else {
            throw new SevereServiceError('[Invalid format] app should be string or an object')
        }

        if (!app.app) {
            throw new SevereServiceError(`[Invalid app property] supported properties are {id<string>, path<string>, custom_id<string>, shareable_id<string>}.
                        For more details please visit https://www.browserstack.com/docs/app-automate/appium/set-up-tests/specify-app ')`)
        }

        return app
    }

    async _uploadServiceLogs() {
        const clientBuildUuid = this._getClientBuildUuid()
        const response = await uploadLogs(getBrowserStackUser(this._config), getBrowserStackKey(this._config), clientBuildUuid)
        if (response) {
            BStackLogger.info(`Upload response: ${JSON.stringify(response, null, 2)}`)
            BStackLogger.logToFile(`Response - ${format(response)}`, 'debug')
        }
    }

    _updateObjectTypeCaps(capabilities?: Capabilities.TestrunnerCapabilities | WebdriverIO.Capabilities, capType?: string, value?: { [key: string]: unknown }) {
        try {
            if (Array.isArray(capabilities)) {
                capabilities
                    .flatMap((c) => {
                        if ('alwaysMatch' in c) {
                            return c.alwaysMatch as WebdriverIO.Capabilities
                        }

                        if (Object.values(c).length > 0 && Object.values(c).every(c => typeof c === 'object' && c.capabilities)) {
                            return Object.values(c).map((o) => o.capabilities) as WebdriverIO.Capabilities[]
                        }
                        return c as WebdriverIO.Capabilities
                    })
                    .forEach((capability: WebdriverIO.Capabilities) => {
                        if (
                            validateCapsWithNonBstackA11y(capability.browserName, capability.browserVersion) &&
                            capType === 'goog:chromeOptions' && value
                        ) {
                            const chromeOptions =  capability['goog:chromeOptions'] as unknown as Capabilities.ChromeOptions
                            if (chromeOptions){
                                const finalChromeOptions = mergeChromeOptions(chromeOptions, value)
                                capability['goog:chromeOptions'] = finalChromeOptions
                            } else {
                                capability['goog:chromeOptions'] = value
                            }
                            return
                        }
                        if (!capability['bstack:options']) {
                            const extensionCaps = Object.keys(capability).filter((cap) => cap.includes(':'))
                            if (extensionCaps.length) {
                                if (capType === 'accessibilityOptions' && value) {
                                    capability['bstack:options'] = { accessibilityOptions: value }
                                }
                            } else if (capType === 'accessibilityOptions') {
                                if (value) {
                                    const accessibilityOpts = { ...value }
                                    // @ts-expect-error fix invalid cap
                                    if (capability?.accessibility) {
                                        accessibilityOpts.authToken = process.env.BSTACK_A11Y_JWT
                                        accessibilityOpts.scannerVersion = process.env.BSTACK_A11Y_SCANNER_VERSION
                                    }
                                    capability['browserstack.accessibilityOptions'] = accessibilityOpts
                                } else {
                                    delete capability['browserstack.accessibilityOptions']
                                }
                            }
                        } else if (capType === 'accessibilityOptions') {
                            if (value) {
                                const accessibilityOpts = { ...value }
                                if (capability['bstack:options'].accessibility) {
                                    accessibilityOpts.authToken = process.env.BSTACK_A11Y_JWT
                                    accessibilityOpts.scannerVersion = process.env.BSTACK_A11Y_SCANNER_VERSION
                                }
                                capability['bstack:options'].accessibilityOptions = accessibilityOpts
                            } else {
                                delete capability['bstack:options'].accessibilityOptions
                            }
                        }
                    })
            } else if (typeof capabilities === 'object') {
                Object.entries(capabilities as Capabilities.RequestedMultiremoteCapabilities).forEach(([, caps]) => {
                    if (
                        validateCapsWithNonBstackA11y(
                            (caps.capabilities as WebdriverIO.Capabilities).browserName,
                            (caps.capabilities as WebdriverIO.Capabilities).browserVersion
                        ) &&
                        capType === 'goog:chromeOptions' && value
                    ) {
                        const chromeOptions = (caps.capabilities as WebdriverIO.Capabilities)['goog:chromeOptions'] as unknown as Capabilities.ChromeOptions
                        if (chromeOptions) {
                            const finalChromeOptions = mergeChromeOptions(chromeOptions, value);
                            (caps.capabilities as WebdriverIO.Capabilities)['goog:chromeOptions'] = finalChromeOptions
                        } else {
                            (caps.capabilities as WebdriverIO.Capabilities)['goog:chromeOptions'] = value
                        }
                        return
                    }
                    if (!(caps.capabilities as WebdriverIO.Capabilities)['bstack:options']) {
                        const extensionCaps = Object.keys(caps.capabilities).filter((cap) => cap.includes(':'))
                        if (extensionCaps.length) {
                            if (capType === 'accessibilityOptions' && value) {
                                (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { accessibilityOptions: value }
                            }
                        } else if (capType === 'accessibilityOptions') {
                            if (value) {
                                const accessibilityOpts = { ...value }
                                if ((caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibility']) {
                                    accessibilityOpts.authToken = process.env.BSTACK_A11Y_JWT
                                    accessibilityOpts.scannerVersion = process.env.BSTACK_A11Y_SCANNER_VERSION
                                }
                                (caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibilityOptions'] = accessibilityOpts
                            } else {
                                delete (caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibilityOptions']
                            }
                        }
                    } else if (capType === 'accessibilityOptions') {
                        if (value) {
                            const accessibilityOpts = { ...value }
                            if ((caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.accessibility) {
                                accessibilityOpts.authToken = process.env.BSTACK_A11Y_JWT
                                accessibilityOpts.scannerVersion = process.env.BSTACK_A11Y_SCANNER_VERSION
                            }
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.accessibilityOptions = accessibilityOpts
                        } else {
                            delete (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.accessibilityOptions
                        }
                    }
                })
            }
        } catch (error) {
            BStackLogger.debug(`Exception while retrieving capability value. Error - ${error}`)
        }
    }

    _updateCaps(capabilities?: Capabilities.TestrunnerCapabilities, capType?: string, value?: string) {
        if (Array.isArray(capabilities)) {
            capabilities
                .flatMap((c) => {
                    if ('alwaysMatch' in c) {
                        return c.alwaysMatch as WebdriverIO.Capabilities
                    }

                    if (Object.values(c).length > 0 && Object.values(c).every(c => typeof c === 'object' && c.capabilities)) {
                        return Object.values(c).map((o) => o.capabilities) as WebdriverIO.Capabilities[]
                    }
                    return c as WebdriverIO.Capabilities
                })
                .forEach((capability: WebdriverIO.Capabilities) => {
                    if (!capability['bstack:options']) {
                        const extensionCaps = Object.keys(capability).filter((cap) => cap.includes(':'))
                        if (extensionCaps.length) {
                            if (capType === 'local') {
                                capability['bstack:options'] = { local: true }
                            } else if (capType === 'app') {
                                capability['appium:app'] = value
                            } else if (capType === 'buildIdentifier' && value) {
                                capability['bstack:options'] = { buildIdentifier: value }
                            } else if (capType === 'testhubBuildUuid') {
                                capability['bstack:options'] = { testhubBuildUuid: TestOpsConfig.getInstance().buildHashedId }
                            } else if (capType === 'buildProductMap') {
                                capability['bstack:options'] = { buildProductMap: getProductMap(this.browserStackConfig) }
                            } else if (capType === 'accessibility') {
                                capability['bstack:options'] = { accessibility: getBooleanValueFromString(value) }
                            }
                        } else if (capType === 'local'){
                            capability['browserstack.local'] = true
                        } else if (capType === 'app') {
                            // @ts-expect-error fix invalid cap
                            capability.app = value
                        } else if (capType === 'buildIdentifier') {
                            if (value) {
                                capability['browserstack.buildIdentifier'] = value
                            } else {
                                delete capability['browserstack.buildIdentifier']
                            }
                        } else if (capType === 'localIdentifier') {
                            capability['browserstack.localIdentifier'] = value
                        } else if (capType === 'testhubBuildUuid') {
                            capability['browserstack.testhubBuildUuid'] = TestOpsConfig.getInstance().buildHashedId
                        } else if (capType === 'buildProductMap') {
                            capability['browserstack.buildProductMap'] = getProductMap(this.browserStackConfig)
                        } else if (capType === 'accessibility') {
                            capability['browserstack.accessibility'] = getBooleanValueFromString(value)
                        }
                    } else if (capType === 'local') {
                        capability['bstack:options'].local = true
                    } else if (capType === 'app') {
                        capability['appium:app'] = value
                    } else if (capType === 'buildIdentifier') {
                        if (value) {
                            capability['bstack:options'].buildIdentifier = value
                        } else {
                            delete capability['bstack:options'].buildIdentifier
                        }
                    } else if (capType === 'localIdentifier') {
                        capability['bstack:options'].localIdentifier = value
                    } else if (capType === 'testhubBuildUuid') {
                        capability['bstack:options'].testhubBuildUuid = TestOpsConfig.getInstance().buildHashedId
                    } else if (capType === 'buildProductMap') {
                        capability['bstack:options'].buildProductMap = getProductMap(this.browserStackConfig)
                    } else if (capType === 'accessibility') {
                        capability['bstack:options'].accessibility = getBooleanValueFromString(value)
                    }
                })
        } else if (typeof capabilities === 'object') {
            Object.entries(capabilities as Capabilities.RequestedMultiremoteCapabilities).forEach(([, caps]) => {
                if (!(caps.capabilities as WebdriverIO.Capabilities)['bstack:options']) {
                    const extensionCaps = Object.keys(caps.capabilities).filter((cap) => cap.includes(':'))
                    if (extensionCaps.length) {
                        if (capType === 'local') {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { local: true }
                        } else if (capType === 'app') {
                            (caps.capabilities as WebdriverIO.Capabilities)['appium:app'] = value
                        } else if (capType === 'buildIdentifier' && value) {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { buildIdentifier: value }
                        } else if (capType === 'testhubBuildUuid') {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { testhubBuildUuid: TestOpsConfig.getInstance().buildHashedId }
                        } else if (capType === 'buildProductMap') {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { buildProductMap: getProductMap(this.browserStackConfig) }
                        } else if (capType === 'accessibility') {
                            (caps.capabilities as WebdriverIO.Capabilities)['bstack:options'] = { accessibility: getBooleanValueFromString(value) }
                        }
                    } else if (capType === 'local'){
                        (caps.capabilities as WebdriverIO.Capabilities)['browserstack.local'] = true
                    } else if (capType === 'app') {
                        (caps.capabilities as WebdriverIO.Capabilities)['appium:app'] = value
                    } else if (capType === 'buildIdentifier') {
                        if (value) {
                            (caps.capabilities as WebdriverIO.Capabilities)['browserstack.buildIdentifier'] = value
                        } else {
                            delete (caps.capabilities as WebdriverIO.Capabilities)['browserstack.buildIdentifier']
                        }
                    } else if (capType === 'localIdentifier') {
                        (caps.capabilities as WebdriverIO.Capabilities)['browserstack.localIdentifier'] = value
                    } else if (capType === 'testhubBuildUuid') {
                        (caps.capabilities as WebdriverIO.Capabilities)['browserstack.testhubBuildUuid'] = TestOpsConfig.getInstance().buildHashedId
                    } else if (capType === 'buildProductMap') {
                        (caps.capabilities as WebdriverIO.Capabilities)['browserstack.buildProductMap'] = getProductMap(this.browserStackConfig)
                    } else if (capType === 'accessibility') {
                        (caps.capabilities as WebdriverIO.Capabilities)['browserstack.accessibility'] = getBooleanValueFromString(value)
                    }
                } else if (capType === 'local'){
                    (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.local = true
                } else if (capType === 'app') {
                    (caps.capabilities as WebdriverIO.Capabilities)['appium:app'] = value
                } else if (capType === 'buildIdentifier') {
                    if (value) {
                        (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.buildIdentifier = value
                    } else {
                        delete (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.buildIdentifier
                    }
                } else if (capType === 'localIdentifier') {
                    (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.localIdentifier = value
                } else if (capType === 'testhubBuildUuid') {
                    (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.testhubBuildUuid = TestOpsConfig.getInstance().buildHashedId
                } else if (capType === 'buildProductMap') {
                    (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.buildProductMap = getProductMap(this.browserStackConfig)
                } else if (capType === 'accessibility') {
                    (caps.capabilities as WebdriverIO.Capabilities)['bstack:options']!.accessibility = getBooleanValueFromString(value)
                }
            })
        } else {
            throw new SevereServiceError('Capabilities should be an object or Array!')
        }
    }

    _handleBuildIdentifier(capabilities?: Capabilities.TestrunnerCapabilities) {
        if (!this._buildIdentifier) {
            return
        }

        if ((!this._buildName || process.env.BROWSERSTACK_BUILD_NAME) && this._buildIdentifier) {
            this._updateCaps(capabilities, 'buildIdentifier')
            BStackLogger.warn('Skipping buildIdentifier as buildName is not passed.')
            return
        }

        if (this._buildIdentifier && this._buildIdentifier.includes('${DATE_TIME}')){
            const formattedDate = new Intl.DateTimeFormat('en-GB', {
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false })
                .format(new Date())
                .replace(/ |, /g, '-')
            this._buildIdentifier = this._buildIdentifier.replace('${DATE_TIME}', formattedDate)
            this._updateCaps(capabilities, 'buildIdentifier', this._buildIdentifier)
        }

        if (!this._buildIdentifier.includes('${BUILD_NUMBER}')) {
            return
        }

        const ciInfo = getCiInfo()
        if (ciInfo !== null && ciInfo.build_number) {
            this._buildIdentifier = this._buildIdentifier.replace('${BUILD_NUMBER}', 'CI '+ ciInfo.build_number)
            this._updateCaps(capabilities, 'buildIdentifier', this._buildIdentifier)
        } else {
            const localBuildNumber = this._getLocalBuildNumber()
            if (localBuildNumber) {
                this._buildIdentifier = this._buildIdentifier.replace('${BUILD_NUMBER}', localBuildNumber)
                this._updateCaps(capabilities, 'buildIdentifier', this._buildIdentifier)
            }
        }
    }

    _updateBrowserStackPercyConfig() {
        const { percyAutoEnabled = false, percyCaptureMode, buildId, percy } = this._percy || {}

        // Setting to browserStackConfig for populating data in funnel instrumentaion
        this.browserStackConfig.percyCaptureMode = percyCaptureMode
        this.browserStackConfig.percyBuildId = buildId
        this.browserStackConfig.isPercyAutoEnabled = percyAutoEnabled

        // To handle stop percy build
        this._options.percy = percy

        // To pass data to workers
        process.env.BROWSERSTACK_PERCY = String(percy)
        process.env.BROWSERSTACK_PERCY_CAPTURE_MODE = percyCaptureMode
    }

    /**
     * @return {string} if buildName doesn't exist in json file, it will return 1
     *                  else returns corresponding value in json file (e.g. { "wdio-build": { "identifier" : 2 } } => 2 in this case)
     */
    _getLocalBuildNumber() {
        const browserstackFolderPath = path.join(os.homedir(), '.browserstack')
        try {
            if (!fs.existsSync(browserstackFolderPath)){
                fs.mkdirSync(browserstackFolderPath)
            }

            const filePath = path.join(browserstackFolderPath, '.build-name-cache.json')
            if (!fs.existsSync(filePath)) {
                fs.appendFileSync(filePath, JSON.stringify({}))
            }

            const buildCacheFileData = fs.readFileSync(filePath)
            const parsedBuildCacheFileData = JSON.parse(buildCacheFileData.toString())

            if (this._buildName && this._buildName in parsedBuildCacheFileData) {
                const prevIdentifier = parseInt((parsedBuildCacheFileData[this._buildName].identifier))
                const newIdentifier = prevIdentifier + 1
                this._updateLocalBuildCache(filePath, this._buildName, newIdentifier)
                return newIdentifier.toString()
            }
            const newIdentifier = 1
            this._updateLocalBuildCache(filePath, this._buildName, 1)
            return newIdentifier.toString()
        } catch {
            return null
        }
    }

    _updateLocalBuildCache(filePath?:string, buildName?:string, buildIdentifier?:number) {
        if (!buildName || !filePath) {
            return
        }
        const jsonContent = JSON.parse(fs.readFileSync(filePath).toString())
        jsonContent[buildName] = { 'identifier': buildIdentifier }
        fs.writeFileSync(filePath, JSON.stringify(jsonContent))
    }

    _getClientBuildUuid() {
        if (process.env[BROWSERSTACK_TESTHUB_UUID]) {
            return process.env[BROWSERSTACK_TESTHUB_UUID]
        }
        const uuid = this.browserStackConfig?.sdkRunID
        BStackLogger.logToFile(`If facing any issues, please contact BrowserStack support with the Build Run Id - ${uuid}`, 'info')
        return uuid
    }

}
