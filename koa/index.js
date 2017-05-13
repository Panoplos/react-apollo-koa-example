// @flow
import Koa from 'koa'
import logger from 'koa-logger'
import bodyParser from 'koa-bodyparser'
import Router from 'koa-router'
import convert from 'koa-convert'
import passport from 'koa-passport'
import R from 'ramda'
import { graphqlKoa, graphiqlKoa } from 'graphql-server-koa'
import { SubscriptionServer } from 'subscriptions-transport-ws'
import { executableSchema } from './executableSchema'
import subscriptionManager from './subscriptions'
import { resolvers } from './resolvers'
import queryMap from '../extracted_queries.json'
import { env, errorHandler, generateTokens } from './utils'

const app = new Koa()

app.proxy = true

// Logger, Parser & Error Handler
app.use(logger())
app.use(bodyParser())
app.use(errorHandler)
// Authentication
require('./auth')

app.use(passport.initialize())

app.use(async (ctx: Object, next: () => {}) => {
  if (ctx.path === '/graphql' && ctx.request.body.id) {
    const invertedMap = R.invertObj(queryMap)
    ctx.request.body.query = invertedMap[ctx.request.body.id]
  }
  await next()
})

const router = Router()

router.post('/graphql', async (ctx, next) => {
  // Authenticate the session
  await passport.authenticate('jwt', { session: false }, async (err, user) => {
    if (user) {
      await convert(graphqlKoa({ schema: executableSchema }))(ctx, next)
    } else {
      ctx.body = {
        error: {
          message: `Access Denied. Error: ${err}`
        }
      }
      ctx.status = 401
    }
  })(ctx, next)
})

router.get('/graphql', graphqlKoa({ schema: executableSchema }))
router.get('/graphiql', graphiqlKoa({ endpointURL: '/graphql' }))

router.post('/auth/signin', async (ctx, next) => {
  await passport.authenticate('local', { session: false }, async (err, user) => {
    if (user === false) {
      ctx.body = {
        error: {
          type: 'Local',
          message: 'User Name or Password Incorrect.',
          status: 401
        }
      }
      ctx.status = 401
    } else {
      const tokens = generateTokens(user.username, ctx)
      ctx.body = tokens
      ctx.status = 201
    }
  })(ctx, next)
})

router.get('/auth/google/signin', async (ctx, next) => {
  await passport.authenticate('google', { session: false })(ctx, next)
})

router.get('/auth/facebook/signin', async (ctx, next) => {
  await passport.authenticate('facebook', { session: false })(ctx, next)
})

router.get('/auth/twitter/signin', async (ctx, next) => {
  await passport.authenticate('twitter', { session: false })(ctx, next)
})

router.get('/auth/social/signin/callback', async (ctx, next) => {
  const error = {
    type: 'Social',
    message: '',
    status: 401
  }
  const service = ctx.query.service
  if (!service) {
    error.message = 'An attempt was made to continue a social service login without the initial sequence.'
    ctx.body = { error }
    ctx.status = 401
  }
  await passport.authenticate(service, { session: false }, async (err, user) => {
    if (user === false || err !== null) {
      error.message = `Social Login Callback Error: ${err}`
      ctx.body = { error }
      ctx.status = 401
    } else {
      const tokens = generateTokens(user.username, ctx)
      ctx.body = tokens
      ctx.status = 201
    }
  })(ctx, next)
})

router.post('/auth/refresh', async (ctx, next) => {
  // Authenticate the session
  await passport.authenticate('jwt', { session: false }, async (err, user) => {
    if (user) {
      const { accessToken, refreshToken } = generateTokens(user.username, ctx)
      ctx.body = { accessToken, refreshToken }
      ctx.status = 201
    } else {
      ctx.body = {
        error: {
          message: `Access Denied. Error: ${err}`
        }
      }
      ctx.status = 401
    }
  })(ctx, next)
})

app.use(router.routes())
app.use(router.allowedMethods())

const server = app.listen(env('SERVER_PORT', ''), env('SERVER_HOST', ''))

// eslint-disable-next-line no-new
new SubscriptionServer(
  {
    subscriptionManager,
    onSubscribe(message, params) {
      setTimeout(
        () => {
          resolvers.TodoList.todos().forEach((todo) => {
            subscriptionManager.pubsub.publish('todoUpdated', todo)
          })
        },
        0
      )
      return Promise.resolve(params)
    }
  },
  {
    server,
    path: '/graphql-sock'
  }
)
