import { getFullUrl, waitFor } from 'next-test-utils'
import os from 'os'
import type {
  BrowserContextOptions,
  BrowserOptions,
  Playwright,
  SharedPlaywrightState,
} from './browsers/playwright'
import type { Page } from 'playwright'

export type { Playwright }

if (!process.env.TEST_FILE_PATH) {
  process.env.TEST_FILE_PATH = module.parent.filename
}

let deviceIP: string
const isBrowserStack = !!process.env.BROWSERSTACK
;(global as any).browserName = process.env.BROWSER_NAME || 'chrome'

if (isBrowserStack) {
  const nets = os.networkInterfaces()
  for (const key of Object.keys(nets)) {
    let done = false

    for (const item of nets[key]) {
      if (item.family === 'IPv4' && !item.internal) {
        deviceIP = item.address
        done = true
        break
      }
    }
    if (done) break
  }
}

function createAfterCurrentTest() {
  const afterCurrentTestCallbacks = new Set<() => Promise<void>>()

  afterEach(async () => {
    for (const callback of afterCurrentTestCallbacks) {
      await callback()
    }
    afterCurrentTestCallbacks.clear()
  })

  return function afterCurrentTest(cb: () => void | Promise<void>) {
    const wrapped = async () => {
      try {
        await cb()
      } finally {
        afterCurrentTestCallbacks.delete(wrapped)
      }
    }
    afterCurrentTestCallbacks.add(wrapped)
  }
}

const afterCurrentTest = createAfterCurrentTest()

let sharedState: SharedPlaywrightState | null = null
let previousBrowser: Playwright | null = null

afterAll(async () => {
  if (sharedState) {
    await sharedState.destroy()
    sharedState = null
  }
})

export interface WebdriverOptions {
  /**
   * whether to wait for React hydration to finish
   */
  waitHydration?: boolean
  /**
   * allow retrying hydration wait if reload occurs
   */
  retryWaitHydration?: boolean
  /**
   * disable cache for page load
   */
  disableCache?: boolean
  /**
   * the callback receiving page instance before loading page
   * @param page
   * @returns
   */
  beforePageLoad?: (page: Page) => void
  /**
   * browser locale
   */
  locale?: string
  /**
   * disable javascript
   */
  disableJavaScript?: boolean
  headless?: boolean
  /**
   * ignore https errors
   */
  ignoreHTTPSErrors?: boolean
  cpuThrottleRate?: number
  pushErrorAsConsoleLog?: boolean

  /**
   * Override the user agent
   */
  userAgent?: string
}

/**
 *
 * @param appPortOrUrl can either be the port or the full URL
 * @param url the path/query to append when using appPort
 * @returns thenable browser instance
 */
export default async function webdriver(
  appPortOrUrl: string | number,
  url: string,
  options: WebdriverOptions = {}
): Promise<Playwright> {
  if (previousBrowser) {
    console.warn(
      'Calling `next.browser()` multiple times in a single test is not recommended. use `browser.loadPage()` instead.'
    )
    if (!previousBrowser.isClosed()) {
      await previousBrowser.close()
    }
    previousBrowser = null
  }

  const {
    waitHydration = true,
    retryWaitHydration = false,
    disableCache = false,
    beforePageLoad,
    locale = undefined,
    disableJavaScript = false,
    ignoreHTTPSErrors = false,
    headless = !!process.env.HEADLESS,
    cpuThrottleRate = undefined,
    pushErrorAsConsoleLog = false,
    userAgent = undefined,
  } = options

  const { Playwright, SharedPlaywrightState } = await import(
    './browsers/playwright'
  )

  const browserOptions: BrowserOptions = {
    browserName: process.env.BROWSER_NAME || 'chrome',
    headless,
    enableTracing: !!process.env.TRACE_PLAYWRIGHT,
  }
  const browserContextOptions: BrowserContextOptions = {
    locale,
    javaScriptEnabled: !disableJavaScript,
    ignoreHTTPSErrors,
    userAgent,
    deviceName: process.env.DEVICE_NAME || undefined,
  }

  if (!sharedState) {
    sharedState = await SharedPlaywrightState.create(
      browserOptions,
      browserContextOptions
    )
  } else {
    if (sharedState.canUpdateAndReuse(browserOptions)) {
      await sharedState.update(browserContextOptions)
    } else {
      await sharedState.destroy()
      sharedState = await SharedPlaywrightState.create(
        browserOptions,
        browserContextOptions
      )
    }
  }

  const browser = new Playwright(sharedState)
  previousBrowser = browser

  afterCurrentTest(async () => {
    if (!browser.isClosed()) {
      await browser.close()
    }
    if (previousBrowser === browser) {
      previousBrowser = null
    }
  })
  ;(global as any).browserName = browserOptions.browserName

  const fullUrl = getFullUrl(
    appPortOrUrl,
    url,
    isBrowserStack ? deviceIP : 'localhost'
  )

  console.log(`\n> Loading browser with ${fullUrl}\n`)

  await browser.loadPage(fullUrl, {
    disableCache,
    cpuThrottleRate,
    beforePageLoad,
    pushErrorAsConsoleLog,
    waitHydration,
    retryWaitHydration,
  })
  console.log(`\n> Loaded browser with ${fullUrl}\n`)

  // This is a temporary workaround for turbopack starting watching too late.
  // So we delay file changes to give it some time
  // to connect the WebSocket and start watching.
  if (process.env.IS_TURBOPACK_TEST) {
    await waitFor(1000)
  }
  return browser
}
