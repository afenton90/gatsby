#! /usr/bin/env node

const crypto = require(`crypto`)
const { URL } = require(`url`)

const puppeteer = require(`puppeteer`)
const ProgressBar = require(`progress`)
const { blue, green, bold, dim } = require(`chalk`)

const createLogger = require(`./logger`)
const fetchRoutes = require(`./fetch-routes`)
const { load, save, cacheFile } = require(`./cache`)
const { ellipses } = require(`./utils`)

const {
  PORT = 8000,
  HOST = `localhost`,
  LOG_LEVEL = `error`,
  GRAPHQL_PATH = `/___graphql`,
} = process.env

const logger = createLogger(LOG_LEVEL)

const devServer = `http://${HOST}:${PORT}`
const endpoint = path => `${devServer}${path}`

export async function main() {
  logger.newline()
  logger.info(`loading cache`)
  const cache = await load()

  logger.info(`requesting route listing`)
  const routes = await fetchRoutes({
    logger,
    cache,
    endpoint: endpoint(GRAPHQL_PATH),
  })

  const sections = [
    dim(` crawling routes`),
    `:bar`,
    bold(blue(`:percent`)),
    dim(`eta :etas`),
    ``,
  ]
  const bar = new ProgressBar(sections.join(` `), {
    width: 35,
    total: routes.length,
    complete: `█`,
    incomplete: ` `,
  })
  logger.setAdapter((...args) => bar.interrupt(args.join(` `)))

  const browser = await puppeteer.launch({ args: process.argv.slice(2) })
  const page = await browser.newPage()
  page.on(`requestfinished`, req => {
    if (req.url().match(/(socket\.io|commons\.js)/)) return

    logger.info(`load`, req.method(), req.url())

    if (req.method() === `GET` && req.resourceType() === `font`) {
      logger.debug(`match`, req.url())

      const { pathname } = new URL(page.url())

      if (!Object.prototype.hasOwnProperty.call(cache.assets, pathname)) {
        cache.assets[pathname] = Object.create(null)
      }

      const isSelfHosted = req.url().startsWith(devServer)

      const fontUrl = isSelfHosted
        ? req.url().slice(devServer.length)
        : req.url()

      cache.assets[pathname][fontUrl] = true

      bar.interrupt(green(ellipses(` found ${fontUrl}`, 80)))
    }
  })

  const hash = crypto.createHash(`md5`)
  for (const route of routes) {
    // wait until there are no more than 2 network connections for 500ms
    // to allow for dynamically inserted <link> and <script> tags to load
    // (there will always be one active connection since the dev server
    // keeps a connection open for hot module reloading so we can't wait
    // for networkidle0)
    //
    // unfortunately, this increases the minimum load time per route to
    // ~500ms, which adds up quickly on large sites; there may be room
    // for optimization here
    hash.update(route)
    logger.info(`visit`, route)
    await page.goto(endpoint(route), { waitUntil: `networkidle2` })
    bar.tick()
  }

  await browser.close()
  logger.resetAdapter()

  cache.hash = hash.digest(`hex`)
  cache.timestamp = Date.now()
  await save(cache)

  logger.print(`

  ${green(`ok!`)} a mapping between your application's routes and
      font requirements has been generated; make sure to
      add ${bold(`\`gatsby-plugin-preload-fonts\``)} to your app config

        - ${dim(`output`)} ${bold(cacheFile)}

`)
}

if (process.env.NODE_ENV !== `test`) main()
