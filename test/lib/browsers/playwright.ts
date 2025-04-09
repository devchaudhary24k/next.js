import {
  chromium,
  webkit,
  firefox,
  Browser,
  BrowserContext,
  Page,
  ElementHandle,
  devices,
  Locator,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from 'playwright'
import path from 'path'

type EventType = 'request' | 'response'

export type BrowserOptions = {
  browserName: string
  headless: boolean
  enableTracing: boolean
}

export type BrowserContextOptions = {
  locale: string
  javaScriptEnabled: boolean
  ignoreHTTPSErrors: boolean
  userAgent: string | undefined
  deviceName: string | undefined
}

type TraceState =
  | { kind: 'initial' }
  | { kind: 'starting'; name: string; fileName: string }
  | { kind: 'started'; name: string; fileName: string }
  | { kind: 'ending'; name: string }
  | { kind: 'ended' }

export class SharedPlaywrightState {
  private nextTraceId = 0
  private traceState: TraceState = { kind: 'initial' }

  private constructor(
    public browser: Browser,
    public context: BrowserContext,
    public browserOptions: BrowserOptions,
    public contextOptions: BrowserContextOptions
  ) {}

  static async create(
    browserOptions: BrowserOptions,
    contextOptions: BrowserContextOptions
  ): Promise<SharedPlaywrightState> {
    const { browserName, headless } = browserOptions
    const browser = await launchBrowser(browserName, { headless })

    const tracingEnabled = browserOptions.enableTracing
    const context = await SharedPlaywrightState.createBrowserContext(
      browser,
      contextOptions,
      tracingEnabled
    )
    const instance = new SharedPlaywrightState(
      browser,
      context,
      browserOptions,
      contextOptions
    )

    return instance
  }

  private static async createBrowserContext(
    browser: Browser,
    options: BrowserContextOptions,
    tracingEnabled: boolean
  ) {
    const {
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      userAgent,
      deviceName,
    } = options

    type Devices = typeof import('playwright').devices
    type Device = Devices[keyof Devices]
    let device: Device | undefined

    if (deviceName !== undefined) {
      device = devices[deviceName]
      if (!device) {
        throw new Error(`Invalid Playwright device name ${deviceName}`)
      }
    }

    const context = await browser.newContext({
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      ...(userAgent ? { userAgent } : {}),
      ...device,
    })

    if (tracingEnabled) {
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      })
    }

    patchBrowserContextRemoveAllListeners(context)
    return context
  }

  async canUpdateAndReuse(browserOptions: BrowserOptions) {
    // if a browser configuration option changed, we have to recreate the whole state.
    return !SharedPlaywrightState.optionChanged(
      this.browserOptions,
      browserOptions
    )
  }

  async update(newOptions: BrowserContextOptions) {
    // if a browser context configuration option changed, we have to recreate the context.
    if (SharedPlaywrightState.optionChanged(this.contextOptions, newOptions)) {
      await this.closeContext()

      this.context = await SharedPlaywrightState.createBrowserContext(
        this.browser,
        newOptions,
        this.tracingEnabled()
      )
      this.contextOptions = newOptions
    }
  }

  private static optionChanged<T extends Record<string, any>>(
    prev: T,
    current: T
  ): boolean {
    for (const [key, prevValue] of Object.entries(prev)) {
      const currentValue = current[key]
      if (currentValue !== prevValue) {
        return true
      }
    }
    return false
  }

  async destroy() {
    await this.closeContext()
    this.context = null!
    await this.browser.close()
    this.browser = null!
  }

  async closeContext() {
    if (this.tracingEnabled()) {
      await this.teardownTracing()
    }
    const context = this.context
    await closeBrowserContextPages(context)
    await cleanupBrowserContext(context)
    await context.close()
  }

  tracingEnabled() {
    return this.browserOptions.enableTracing
  }

  private async teardownTracing() {
    if (!this.tracingEnabled()) {
      return
    }

    if (
      this.traceState.kind === 'started' ||
      this.traceState.kind === 'starting'
    ) {
      const { name } = this.traceState
      // if the trace didn't get ended normally for some reason, we should end it here to avoid dropping it.
      try {
        await this.endTrace()
      } catch (err) {
        require('console').warn(`Failed to end playwright trace '${name}'`, err)
      }
    }

    try {
      await this.context.tracing.stop()
    } catch (e) {
      require('console').warn('Failed to teardown playwright tracing', e)
    }
  }

  async startTrace(name: string): Promise<string> {
    if (!this.tracingEnabled()) {
      return
    }
    if (this.traceState.kind === 'started') {
      // This shouldn't ever happen.
      // We're going to error, but first, clean up the previous trace to prevent cascading errors in other tests.
      try {
        await this.endTrace()
      } catch (err) {
        require('console').warn('Failed to end playwright trace', err)
      }
      throw new Error(
        `Cannot start trace '${name}' while previous trace ${this.traceState.name} is running`
      )
    }

    if (this.traceState.kind === 'ending') {
      throw new Error(
        `Cannot start trace '${name}' while previous trace ${this.traceState.name} is ending`
      )
    }

    // Make sure that the filename doesn't exceed 255 characters,
    // which is a common filename length limit.
    // (exceeding it causes an ENAMETOOLONG when saving the trace)
    // https://stackoverflow.com/a/54742403
    const traceId = this.nextTraceId++
    const prefix = `playwright-${traceId}-`
    const suffix = `-${Date.now()}.zip`
    // playwright adds something like this internally, so we need to account for it, plus some safety margin
    const playwrightInternalSuffixLength = '-pwnetcopy-0000.network'.length + 16
    const maxLen =
      255 - (prefix.length + suffix.length + playwrightInternalSuffixLength)
    const fileName = prefix + encodeURIComponent(name).slice(0, maxLen) + suffix

    this.traceState = { kind: 'starting', name, fileName }
    await this.context.tracing.startChunk({
      name: fileName,
      title: `${traceId}. ${name}`,
    })
    this.traceState = { kind: 'started', name, fileName }
  }

  async endTrace() {
    if (!this.tracingEnabled()) {
      return
    }
    if (this.traceState.kind !== 'started') {
      throw new Error('Cannot call endTrace with no active trace')
    }

    const traceDir = path.join(__dirname, '../../traces')
    const traceOutputPath = path.join(
      traceDir,
      `${path
        .relative(path.join(__dirname, '../../'), process.env.TEST_FILE_PATH)
        .replace(/\//g, '-')}`,
      this.traceState.fileName
    )
    this.traceState = {
      kind: 'ending',
      name: this.traceState.name,
    }
    try {
      await this.context.tracing.stopChunk({ path: traceOutputPath })
    } finally {
      this.traceState = { kind: 'ended' }
    }
  }
}

async function launchBrowser(
  browserName: string,
  launchOptions: Record<string, any>
) {
  if (browserName === 'safari') {
    return await webkit.launch(launchOptions)
  } else if (browserName === 'firefox') {
    return await firefox.launch({
      ...launchOptions,
      firefoxUserPrefs: {
        ...launchOptions.firefoxUserPrefs,
        // The "fission.webContentIsolationStrategy" pref must be
        // set to 1 on Firefox due to the bug where a new history
        // state is pushed on a page reload.
        // See https://github.com/microsoft/playwright/issues/22640
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=1832341
        'fission.webContentIsolationStrategy': 1,
      },
    })
  } else {
    return await chromium.launch({
      devtools: !launchOptions.headless,
      ...launchOptions,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    })
  }
}

const defaultTimeout = process.env.NEXT_E2E_TEST_TIMEOUT
  ? parseInt(process.env.NEXT_E2E_TEST_TIMEOUT, 10)
  : // In development mode, compilation can take longer due to lower CPU
    // availability in GitHub Actions.
    60 * 1000

interface ElementHandleExt extends ElementHandle {
  getComputedCss(prop: string): Promise<string>
  text(): Promise<string>
}

type PageLog = { source: string; message: string; args: unknown[] }

type PageState = {
  page: Page
  logs: Array<Promise<PageLog> | PageLog>
  websocketFrames: Array<{ payload: string | Buffer }>
}

export class Playwright<TCurrent = any> {
  private sharedState: SharedPlaywrightState

  constructor(sharedState: SharedPlaywrightState) {
    this.sharedState = sharedState
  }

  private _pageState: PageState | null = null

  private getReadyState(): PageState {
    if (this._pageState === null) {
      throw new Error('No page available')
    }
    return this._pageState
  }

  private currentPage(): Page {
    const state = this.getReadyState()
    return state.page
  }

  private eventCallbacks: Record<EventType, Set<(...args: any[]) => void>> = {
    request: new Set(),
    response: new Set(),
  }

  on(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  on(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  on(event: EventType, cb: (...args: any[]) => void) {
    if (!this.eventCallbacks[event]) {
      throw new Error(
        `Invalid event passed to browser.on, received ${event}. Valid events are ${Object.keys(
          this.eventCallbacks
        )}`
      )
    }
    this.eventCallbacks[event]?.add(cb)
  }

  off(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  off(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  off(event: EventType, cb: (...args: any[]) => void) {
    this.eventCallbacks[event]?.delete(cb)
  }

  async close(): Promise<void> {
    if (!this._pageState) {
      return
    }
    await this.sharedState.endTrace()
    await this.reset()
  }

  async reset() {
    if (!this._pageState) {
      return
    }
    this._pageState = null
    await closeBrowserContextPages(this.sharedState.context)
  }

  async get(url: string): Promise<void> {
    const page = this.currentPage()
    await page.goto(url)
  }

  async loadPage(
    url: string,
    opts?: {
      disableCache?: boolean
      cpuThrottleRate?: number
      pushErrorAsConsoleLog?: boolean
      beforePageLoad?: (page: Page) => void
      waitHydration?: boolean
      retryWaitHydration?: boolean
    }
  ) {
    if (this._pageState) {
      // loadPage may be called multiple times within a single test.
      // in that case, we need to reset.
      await this.reset()
    } else {
      // if this is the first time loadPage is called in this test, start a trace.
      // otherwise, we should already have a trace running.

      // omit the host from the trace name if it's `localhost[:port]`, because that's not useful.
      const urlObj = new URL(url)
      const traceName =
        urlObj.hostname === 'localhost'
          ? urlObj.pathname + urlObj.search + urlObj.hash
          : url

      await this.sharedState.startTrace(traceName)
    }

    const { context } = this.sharedState

    const setupPage = async (pageState: PageState) => {
      const { page, logs: pageLogs, websocketFrames } = pageState

      page.setDefaultTimeout(defaultTimeout)
      page.setDefaultNavigationTimeout(defaultTimeout)

      page.on('console', (msg) => {
        console.log('browser log:', msg)
        pageLogs.push(
          Promise.all(
            msg.args().map((handle) => handle.jsonValue().catch(() => {}))
          ).then((args) => ({ source: msg.type(), message: msg.text(), args }))
        )
      })
      page.on('crash', () => {
        console.error('page crashed')
      })
      page.on('pageerror', (error) => {
        console.error('page error', error)

        if (opts?.pushErrorAsConsoleLog) {
          pageLogs.push({
            source: 'error',
            message: error.message,
            args: [],
          })
        }
      })
      page.on('request', (req) => {
        this.eventCallbacks.request.forEach((cb) => cb(req))
      })
      page.on('response', (res) => {
        this.eventCallbacks.response.forEach((cb) => cb(res))
      })

      if (opts?.disableCache) {
        // TODO: this doesn't seem to work (dev tools does not check the box as expected)
        const session = await context.newCDPSession(page)
        session.send('Network.setCacheDisabled', { cacheDisabled: true })
      }

      if (opts?.cpuThrottleRate) {
        const session = await context.newCDPSession(page)
        // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate
        session.send('Emulation.setCPUThrottlingRate', {
          rate: opts.cpuThrottleRate,
        })
      }

      page.on('websocket', (ws) => {
        if (this.sharedState.tracingEnabled()) {
          page
            .evaluate(`console.log('connected to ws at ${ws.url()}')`)
            .catch(() => {})

          ws.on('close', () =>
            page
              .evaluate(`console.log('closed websocket ${ws.url()}')`)
              .catch(() => {})
          )
        }
        ws.on('framereceived', (frame) => {
          websocketFrames.push({ payload: frame.payload })

          if (this.sharedState.tracingEnabled()) {
            page
              .evaluate(`console.log('received ws message ${frame.payload}')`)
              .catch(() => {})
          }
        })
      })

      opts?.beforePageLoad?.(page)
    }

    const newPageState: PageState = {
      page: await context.newPage(),
      logs: [],
      websocketFrames: [],
    }

    await setupPage(newPageState)
    this._pageState = newPageState

    await newPageState.page.goto(url, { waitUntil: 'load' })

    const waitHydration = opts?.waitHydration ?? true
    if (waitHydration && this.sharedState.contextOptions.javaScriptEnabled) {
      await this.waitForHydration(opts?.retryWaitHydration)
    }
  }

  async waitForHydration(retry = false) {
    const page = this.currentPage()

    // Wait for application to hydrate
    console.log(`\n> Waiting hydration for ${page.url()}\n`)

    const checkHydrated = async () => {
      await this.evalAsync(function () {
        var callback = arguments[arguments.length - 1]

        // if it's not a Next.js app return
        if (
          !document.documentElement.innerHTML.includes('__NEXT_DATA__') &&
          // @ts-ignore next exists on window if it's a Next.js page.
          typeof ((window as any).next && (window as any).next.version) ===
            'undefined'
        ) {
          console.log('Not a next.js page, resolving hydrate check')
          callback()
        }

        // TODO: should we also ensure router.isReady is true
        // by default before resolving?
        if ((window as any).__NEXT_HYDRATED) {
          console.log('Next.js page already hydrated')
          callback()
        } else {
          var timeout = setTimeout(callback, 10 * 1000)
          ;(window as any).__NEXT_HYDRATED_CB = function () {
            clearTimeout(timeout)
            console.log('Next.js hydrate callback fired')
            callback()
          }
        }
      })
    }

    try {
      await checkHydrated()
    } catch (err) {
      if (retry) {
        // re-try in case the page reloaded during check
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await checkHydrated()
      } else {
        console.error('failed to check hydration')
        throw err
      }
    }

    console.log(`\n> Hydration complete for ${page.url()}\n`)
  }

  back(options?: Parameters<Page['goBack']>[0]) {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.goBack(options)
    })
  }
  forward(options?: Parameters<Page['goForward']>[0]) {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.goForward(options)
    })
  }
  refresh() {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.reload()
    })
  }
  setDimensions({ width, height }: { height: number; width: number }) {
    const page = this.currentPage()
    return this.chain(() => page.setViewportSize({ width, height }))
  }
  addCookie(opts: { name: string; value: string }) {
    const { context } = this.sharedState
    const page = this.currentPage()
    return this.chain(async () =>
      context.addCookies([
        {
          path: '/',
          domain: await page.evaluate('window.location.hostname'),
          ...opts,
        },
      ])
    )
  }
  deleteCookies() {
    const { context } = this.sharedState
    return this.chain(async () => context.clearCookies())
  }

  focusPage() {
    const page = this.currentPage()
    return this.chain(() => page.bringToFront())
  }

  private wrapElement(el: ElementHandle, selector: string): ElementHandleExt {
    const page = this.currentPage()
    function getComputedCss(prop: string) {
      return page.evaluate(
        function (args) {
          const style = getComputedStyle(document.querySelector(args.selector))
          return style[args.prop] || null
        },
        { selector, prop }
      )
    }

    return Object.assign(el, {
      selector,
      getComputedCss,
      text: () => el.innerText(),
    })
  }

  elementByCss(selector: string) {
    return this.waitForElementByCss(selector, 5_000)
  }

  elementById(id: string) {
    return this.elementByCss(`#${id}`)
  }

  getValue(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => el.inputValue())
  }

  text(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => el.innerText())
  }

  type(this: Playwright<ElementHandleExt>, text: string) {
    return this.chain((el: ElementHandleExt) => el.type(text))
  }

  moveTo(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => {
      return el.hover().then(() => el)
    })
  }

  async getComputedCss(this: Playwright<ElementHandleExt>, prop: string) {
    return this.chain((el: ElementHandleExt) => {
      return el.getComputedCss(prop)
    })
  }

  async getAttribute(this: Playwright<ElementHandleExt>, attr: string) {
    return this.chain((el: ElementHandleExt) => el.getAttribute(attr))
  }

  hasElementByCssSelector(selector: string) {
    return this.eval<boolean>(`!!document.querySelector('${selector}')`)
  }

  keydown(key: string) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.keyboard.down(key).then(() => el)
    })
  }

  keyup(key: string) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.keyboard.up(key).then(() => el)
    })
  }

  click(this: Playwright<ElementHandleExt>) {
    return this.chain((el) => {
      return el.click().then(() => el)
    })
  }

  touchStart(this: Playwright<ElementHandleExt>) {
    return this.chain((el) => {
      return el.dispatchEvent('touchstart').then(() => el)
    })
  }

  elementsByCss(selector: string) {
    const page = this.currentPage()
    return this.chain(() =>
      page.$$(selector).then((els) => {
        return els.map((el) => {
          const origGetAttribute = el.getAttribute.bind(el)
          el.getAttribute = (name) => {
            // ensure getAttribute defaults to empty string to
            // match selenium
            return origGetAttribute(name).then((val) => val || '')
          }
          return el
        })
      })
    )
  }

  waitForElementByCss(selector: string, timeout = 10_000) {
    const page = this.currentPage()
    return this.chain(() => {
      return page
        .waitForSelector(selector, { timeout, state: 'attached' })
        .then(async (el) => {
          // it seems selenium waits longer and tests rely on this behavior
          // so we wait for the load event fire before returning
          await page.waitForLoadState()
          return this.wrapElement(el, selector)
        })
    })
  }

  waitForCondition(snippet: string, timeout?: number) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.waitForFunction(snippet, { timeout }).then(() => el)
    })
  }

  eval<T = any>(fn: any, ...args: any[]) {
    const page = this.currentPage()
    return this.chain(() =>
      page
        .evaluate(fn, ...args)
        .catch((err) => {
          console.error('eval error:', err)
          return null
        })
        .then(async (val) => {
          await page.waitForLoadState()
          return val as T
        })
    )
  }

  async evalAsync<T = any>(fn: any) {
    const page = this.currentPage()

    if (typeof fn === 'function') {
      fn = fn.toString()
    }

    if (fn.includes(`var callback = arguments[arguments.length - 1]`)) {
      fn = `(function() {
        return new Promise((resolve, reject) => {
          const origFunc = ${fn}
          try {
            origFunc(resolve)
          } catch (err) {
            reject(err)
          }
        })
      })()`
    }

    return page.evaluate<T>(fn).catch(() => null)
  }

  async log<T extends boolean = false>(options?: { includeArgs?: T }) {
    const state = this.getReadyState()
    return this.chain(
      () =>
        options?.includeArgs
          ? Promise.all(state.logs)
          : Promise.all(state.logs).then((logs) =>
              logs.map(({ source, message }) => ({ source, message }))
            )
      // TODO: Starting with TypeScript 5.8 we might not need this type cast.
    ) as Promise<
      T extends true
        ? { source: string; message: string; args: unknown[] }[]
        : { source: string; message: string }[]
    >
  }

  async websocketFrames() {
    const state = this.getReadyState()
    return this.chain(() => state.websocketFrames)
  }

  async url() {
    const page = this.currentPage()
    return this.chain(() => page.url())
  }

  async waitForIdleNetwork() {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.waitForLoadState('networkidle').then(() => el)
    })
  }

  locateRedbox(): Locator {
    const page = this.currentPage()
    return page.locator(
      'nextjs-portal [aria-labelledby="nextjs__container_errors_label"]'
    )
  }

  locateDevToolsIndicator(): Locator {
    const page = this.currentPage()
    return page.locator('nextjs-portal [data-nextjs-dev-tools-button]')
  }

  private promise?: Promise<TCurrent>;

  // necessary for the type of the function below
  readonly [Symbol.toStringTag]: string = 'Playwright'

  private chain<TNext>(
    this: Playwright<TCurrent>,
    nextCall: (current: TCurrent) => TNext | Promise<TNext>
  ): Playwright<TNext> & Promise<TNext> {
    const syncError = new Error('next-browser-base-chain-error')
    const promise = Promise.resolve(this.promise)
      .then(nextCall)
      .catch((reason) => {
        if (
          reason !== null &&
          typeof reason === 'object' &&
          'stack' in reason
        ) {
          const syncCallStack = syncError.stack.split(syncError.message)[1]
          reason.stack += `\n${syncCallStack}`
        }
        throw reason
      })

    function get(target: Playwright<TNext>, p: string | symbol): any {
      switch (p) {
        case 'promise':
          return promise
        case 'then':
          return promise.then.bind(promise)
        case 'catch':
          return promise.catch.bind(promise)
        case 'finally':
          return promise.finally.bind(promise)
        default:
          return target[p]
      }
    }

    return new Proxy<any>(this, {
      get,
    })
  }
}

async function cleanupBrowserContext(context: BrowserContext) {
  // Clean up the existing browser context as best we can.
  await Promise.all([
    // NOTE: this uses the patched version installed in patchBrowserContextRemoveAllListeners
    context.removeAllListeners(undefined, { behavior: 'wait' }),
    context.unrouteAll({ behavior: 'wait' }),
    context.clearCookies(),
    context.clearPermissions(),
  ])
}

async function closeBrowserContextPages(context: BrowserContext) {
  const pages = context.pages()
  await Promise.all(pages.map((page) => closePage(page)))
}

async function closePage(page: Page) {
  if (page.isClosed) {
    return
  }
  await Promise.all([
    page.removeAllListeners(undefined, { behavior: 'wait' }),
    page.unrouteAll({ behavior: 'wait' }),
  ])
  await page.close()
}

/**
 * `BrowserContext.removeAllListeners(undefined)` breaks playwright internals,
 * because it removes an internal 'close' listener that `BrowserContext.close()` depends on.
 * This function patches `removeAllListeners` to avoid that.
 */
function patchBrowserContextRemoveAllListeners(context: BrowserContext) {
  type SomeListenerCallback = (...args: any[]) => any

  const eventTypes = new Set<string>()
  const trackEventType = (event: string) => {
    // we don't currently use the 'close' event anywhere, but it's safer to be defensive.
    if (event === 'close') {
      throw new Error(
        `Removing 'close' listeners breaks Playwright internals, so we don't allow adding them`
      )
    }
    eventTypes.add(event)
  }

  // track the event types of event listeners added to BrowserContext.

  const contextOn = context.on.bind(context)
  context.on = (event: string, listener: SomeListenerCallback) => {
    trackEventType(event)
    return contextOn(event, listener)
  }

  const contextOnce = context.once.bind(context)
  context.once = (event: string, listener: SomeListenerCallback) => {
    trackEventType(event)
    return contextOnce(event, listener)
  }

  const contextAddListener = context.addListener.bind(context)
  context.addListener = (event: string, listener: SomeListenerCallback) => {
    trackEventType(event)
    return contextAddListener(event, listener)
  }

  const contextRemoveAllListeners = context.removeAllListeners.bind(
    context
  ) as BrowserContext['removeAllListeners']
  context.removeAllListeners = ((
    event: string | undefined,
    options?: { behavior?: 'wait' | 'ignoreErrors' | 'default' }
  ) => {
    // `BrowserContext.removeAllListeners(undefined)` breaks playwright internals,
    // because it removes an internal 'close' listener that `BrowserContext.close()` depends on.
    // Instead, remove each event type we've seen individually.
    // We guarantee that no new 'close' listeners were added in `trackEventType`,
    // so this will sidestep the playwright bug.
    if (event === undefined) {
      // if no `options` are passed, `BrowserContext.removeAllListeners` returns `this`.
      if (!options) {
        for (const event of eventTypes) {
          contextRemoveAllListeners(event, undefined)
        }
        return context
      } else {
        // if an `options` object is passed, `BrowserContext.removeAllListeners` returns a promise.
        return Promise.all(
          [...eventTypes.values()].map((event) =>
            contextRemoveAllListeners(event, options)
          )
        ).then(() => {})
      }
    }
    return contextRemoveAllListeners(event, options)
  }) as BrowserContext['removeAllListeners']
}
