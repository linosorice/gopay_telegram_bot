const mongo = require('mongodb')
const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const request = require('request')
const utils = require('./utils.js')
const TelegramBot = require('node-telegram-bot-api')
const dotenv = require('dotenv')
dotenv.load()

var GUARD_BOT_TOKEN = process.env.GUARD_BOT_TOKEN // Bot which communicate errors
var PORT = process.env.PORT || 3333

var MongoClient = mongo.MongoClient
var url = process.env.MONGO_DB

var bots = {} // channel : TelegramBot
var guardBot

// Set guard bot
if (process.argv[2] === 'prod') {
  guardBot = new TelegramBot(GUARD_BOT_TOKEN, {polling: true})
  utils.getGuardChat(guardBot, MongoClient, url, function (chatId) { guardBot.currentChat = chatId })
  guardBot.onText(/\/setup (.+)/, function (msg, match) {
    if (match[1] === 'cto') {
      guardBot.currentChat = msg.chat.id
      utils.sendTelegramMessage(msg.chat.id, 'That\'s my new home!', GUARD_BOT_TOKEN)
      utils.storeGuardChat(msg.chat.id, MongoClient, url)
    }
  })
  guardBot.onText(/\/truth/, function (msg, match) {
    utils.sendTelegramMessage(msg.chat.id, 'Taranto merda e forza Bari!', GUARD_BOT_TOKEN)
  })
}

MongoClient.connect(url, function (err, db) {
  if (err) throw err
  console.log('[mongodb] db created')

  db.createCollection('bots', function (err, res) {
    if (err) throw err
    console.log('[mongodb] collection bots created')
    setupBots(function () {
      db.createCollection('offers', function (err, res) {
        if (err) throw err
        console.log('[mongodb] collection offers created')
        setupOffers()

        db.createCollection('guard', function (err, res) {
          if (err) throw err
          console.log('[mongodb] collection guard created')
          db.close()
        })
      })
    })
  })
})

app.use(bodyParser.json())

app.get('/', function (req, res) {
  res.send('Up and running')
})

// Database drop in development
if (process.argv[2] === 'dev') {
  app.get('/drop', function (req, res) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.dropDatabase()
      res.send('Database drop')
    })
  })
}

app.post('/bot', function (req, res) {
  addBot(req.body)
  storeBot(req.body)
  res.send('Bot successfully added')
})

app.post('/offer', function (req, res) {
  sendOffer(req.body, function (err) {
    if (err) { res.status(400).send(err) } else { res.send('Offer sent on channel ' + req.body.channel) }
  })
})

/* Send guard message
* "message": "Error!"
*/
if (process.argv[2] === 'prod') {
  app.post('/guard', function (req, res) {
    utils.sendTelegramMessage(guardBot.currentChat, req.body.message, GUARD_BOT_TOKEN)
  })
}

app.listen(PORT, function () {
  console.log('Listening on ' + PORT)
})

function addBot (data, res) {
  var bot = new TelegramBot(data.botToken, {polling: true})
  bot.botToken = data.botToken
  bot.paymentToken = data.paymentToken
  bot.channel = data.channel
  bot.email = data.email

  // Set payment callbacks
  bot.on('pre_checkout_query', (query) => {
    console.log('[bot] pre checkout')
    console.log(query.invoice_payload)

    // Check limit
    var payload = JSON.parse(query.invoice_payload)
    utils.getOffer(payload.offerId, MongoClient, url, function (offer) {
      if (parseInt(offer.quantity) > 0 && offer.sold >= parseInt(offer.quantity)) {
        bot.answerPreCheckoutQuery(query.id, false, { error_message: utils.getLocalizedString(payload.lang, 'offer_depleted') })
      } else {
        bot.answerPreCheckoutQuery(query.id, true)
      }
    })
  })

  bot.on('successful_payment', (msg) => {
    console.log('[bot] successful payment')
    // console.log(msg);

    var payload = JSON.parse(msg.successful_payment.invoice_payload)
    var purchaseCode = generatePurchaseCode()
    bot.sendMessage(payload.chatId, utils.getLocalizedString(payload.lang, 'successful_payment') + purchaseCode)
    sendPurchase(bot.email, msg, purchaseCode)

    // Guard bot
    if (process.argv[2] === 'prod') {
      utils.sendTelegramMessage(guardBot.currentChat,
        'Sir, new offer purchased!\nChannel: ' + bot.channel, GUARD_BOT_TOKEN)
    }

    // Store offer sold
    utils.storeOfferSold(payload.offerId, MongoClient, url)
  })

  // Set command callback
  bot.onText(/\/start (.+)/, function (msg, match) {
    utils.getOffer(match[1], MongoClient, url, function (offer) {
      if (!offer) return

      // Check expiration
      var offerDate = new Date(offer.expiration)
      var nowDate = new Date()
      offerDate.setDate(nowDate.getDate() + 1)

      // Set language
      var lang = msg.from.language_code === 'it-IT' ? 'it' : 'en'

      if (offerDate.getTime() < nowDate.getTime()) {
        utils.sendTelegramMessage(msg.chat.id, utils.getLocalizedString(lang, 'offer_expired'), bot.botToken)
        return
      }

      // Check limit
      if (parseInt(offer.quantity) > 0 && offer.sold >= parseInt(offer.quantity)) {
        utils.sendTelegramMessage(msg.chat.id, utils.getLocalizedString(lang, 'offer_depleted'), bot.botToken)
        return
      }

      // Send invoice
      var options = {
        url: 'https://api.telegram.org/bot' + bot.botToken + '/sendInvoice',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        form: {
          'chat_id': msg.chat.id,
          'title': offer.title,
          'description': offer.description,
          'payload': JSON.stringify({offerId: match[1], chatId: msg.chat.id, lang: lang}),
          'provider_token': offer.paymentToken, // 284685063:TEST:ZmRkZmFhMDAxNDFj
          'start_parameter': 'start',
          'currency': offer.currency,
          'prices': JSON.stringify([{label: offer.title, amount: parseInt(offer.amount * 100)}]),
          'photo_url': offer.image,
          'photo_width': 800,
          'photo_height': 533,
          'need_name': offer.shipping,
          'need_email': offer.shipping,
          'need_shipping_address': offer.shipping
        }
      }

      request(options, function (error, response, body) {
        if (!error && response.statusCode === 200) {
        } else {
        }
      })
    })
  })

  // Handle polling error
  bot.on('polling_error', (error) => {
    // Guard bot
    if (process.argv[2] === 'prod' && error.code) {
      if (error.code === 'EPARSE') {
        utils.sendTelegramMessage(guardBot.currentChat,
          'Sir, we got an issue on Gopay!\nEnvironment: ' + process.argv[2] + '\nError code: ' + error.code + '\nBot Token: ' + bot.botToken + '\nBody: ' + error.response.body, GUARD_BOT_TOKEN)
      } else {
        /* utils.sendTelegramMessage(guardBot.currentChat,
          'Sir, we got an issue on Gopay!\nEnvironment: ' + process.argv[2] + '\nError code: ' + error.code + '\nBot Token: ' + bot.botToken, GUARD_BOT_TOKEN); */
      }
    }

    if (error.code === 'ETELEGRAM' && bots[data.channel]) {
      bots[data.channel].stopPolling()
      utils.removeBot(bot.botToken, MongoClient, url, function () {})
      delete bots[data.channel]
    }
  })

  bots[data.channel] = bot
}

/* function addOffer(data) {
  var bot = bots[data.channel];
  bot.offers[data.offerId] = data;
} */

function sendOffer (data) {
  var bot = bots[data.channel]

  if (!bot) {
    return 'No bot associated to this token'
  }

  data.botToken = bot.botToken
  data.paymentToken = bot.paymentToken

  // addOffer(data);
  storeOffer(data)

  getBotUsername(data.botToken, function (username) {
    console.log('Sending offer to ' + data.channel)

    // Currency symbol
    var currencySymbol
    switch (data.currency) {
      case 'EUR':
        currencySymbol = '€'
        break
      case 'USD':
        currencySymbol = '$'
        break
      case 'GBP':
        currencySymbol = '£'
        break
    }

    // Send message on channel
    var title = '*' + data.title + '*\n\n'
    var descr = data.description + '\n\n'
    var amount = '*' + currencySymbol + data.amount + '*\n'
    var text = title + descr + amount

    // Set limit
    if (data.quantity > 0) {
      text += '\n*' + utils.getLocalizedString(data.lang, 'available') + data.quantity + '*'
    }

    // Send image
    var options = {
      url: 'https://api.telegram.org/bot' + data.botToken + '/sendPhoto',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      form: {
        'chat_id': '@' + data.channel,
        'photo': data.image
        // 'caption': data.title
      }
    }

    request(options, function (error, response, body) {
      if (error) throw error
      console.log(body)

      // Guard bot
      if (process.argv[2] === 'prod') {
        if (!body.ok) {
          utils.sendTelegramMessage(guardBot.currentChat,
            'Sir, we got an issue on Gopay!\nEnvironment: ' + process.argv[2] + '\nError: ' + body.description + '\nChannel: ' + data.channel, GUARD_BOT_TOKEN)
        } else {
          utils.sendTelegramMessage(guardBot.currentChat,
            'New offer sent on channel ' + data.channel + '!\nTitle: ' + data.title + '\nPrice ' + data.amount + ' ' + currencySymbol, GUARD_BOT_TOKEN)
        }
      }

      var buyNow = utils.getLocalizedString(data.lang, 'buy_now')

      // Send text
      var options = {
        url: 'https://api.telegram.org/bot' + data.botToken + '/sendMessage',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        form: {
          'chat_id': '@' + data.channel,
          'text': text,
          'parse_mode': 'Markdown',
          'reply_markup': JSON.stringify({
            inline_keyboard: [
              [{text: buyNow, url: 'https://telegram.me/' + username + '?start=' + data.offerId}]
            ]
          })
        }
      }

      request(options, function (error, response, body) {
        if (error) throw error
        console.log(body)
        // Guard bot
        if (!body.ok && process.argv[2] === 'prod') {
          utils.sendTelegramMessage(guardBot.currentChat,
            'Sir, we got an issue on Gopay!\nEnvironment: ' + process.argv[2] + '\nError: ' + body.description + '\nChannel: ' + data.channel, GUARD_BOT_TOKEN)
        }
      })
    })
  })
}

// Store bot in db
function storeBot (data) {
  MongoClient.connect(url, function (err, db) {
    if (err) throw err
    var obj = { botToken: data.botToken, paymentToken: data.paymentToken, channel: data.channel, email: data.email }
    db.collection('bots').insertOne(obj, function (err, res) {
      if (err) throw err
      console.log('[mongodb] bot ' + data.botToken + ' in channel ' + data.channel + ' stored')
      db.close()
    })
  })
}

// Store offer in db
function storeOffer (data) {
  MongoClient.connect(url, function (err, db) {
    if (err) throw err
    db.collection('offers').insertOne(data, function (err, offer) {
      if (err) throw err
      console.log('[mongodb] offer ' + data.offerId + ' in channel ' + data.channel + ' stored')
      db.close()
    })
  })
}

// Startup routine
function setupBots (cb) {
  // Load bots in memory
  MongoClient.connect(url, function (err, db) {
    if (err) throw err
    db.collection('bots').find({}).toArray(function (err, result) {
      if (err) throw err
      for (var i = 0; i < result.length; i++) {
        var data = {
          botToken: result[i].botToken,
          paymentToken: result[i].paymentToken,
          channel: result[i].channel,
          email: result[i].email
        }

        addBot(data)
        console.log('[setup] bot ' + result[i].botToken + ' in channel ' + result[i].channel + ' loaded')
      }
      db.close()
      cb()
    })
  })
}

function setupOffers () {
  MongoClient.connect(url, function (err, db) {
    if (err) throw err
    db.collection('offers').find({}).toArray(function (err, result) {
      if (err) throw err
      for (var i = 0; i < result.length; i++) {
        // addOffer(result[i]);
        console.log('[setup] offer ' + result[i].offerId + ' in channel ' + result[i].channel + ' loaded')
      }
      db.close()
    })
  })
}

function sendPurchase (email, paymentData, purchaseCode) {
  var options = {
    url: process.env.GOPAY_HOST + '/checkout',
    method: 'POST',
    headers: {
      'Accept-Language': paymentData.from.language_code
    },
    json: {
      email: email,
      paymentData: paymentData,
      purchaseCode: purchaseCode
    }
  }

  request(options, function (error, response, body) {
    if (error) throw error
    console.log(body)
  })
}

function generatePurchaseCode () {
  var text = ''
  var possible = '0123456789'

  for (var i = 0; i < 6; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)) }

  return text
}

function getBotUsername (botToken, cb) {
  request('https://api.telegram.org/bot' + botToken + '/getMe', function (error, response, body) {
    if (error) throw error
    cb(JSON.parse(body).result.username)
  })
}
