const request = require('request')
const fs = require('fs')

module.exports = {
  sendTelegramMessage: function (chatId, message, botToken) {
    var options = {
      url: 'https://api.telegram.org/bot' + botToken + '/sendMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      form: {
        'chat_id': chatId,
        'text': message,
        'parse_mode': 'Markdown'
      }
    }

    request(options, function (error, response, body) { if (error) throw error })
  },

  storeOfferSold: function (offerId, MongoClient, url) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('offers').update({offerId: offerId}, {$inc: {'sold': 1}}, function (err, res) {
        if (err) throw err
        db.close()
      })
    })
  },

  getOffer: function (offerId, MongoClient, url, cb) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('offers').findOne({offerId: offerId}, function (err, offer) {
        if (err) throw err
        cb(offer)
        db.close()
      })
    })
  },

  botHasOffer: function (bot, offerId, MongoClient, url, cb) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('offers').findOne({}, function (err, offer) {
        if (err) throw err
        cb(offer)
        db.close()
      })
    })
  },

  removeBot: function (botToken, MongoClient, url, cb) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('bots').remove({botToken: botToken}, function (err, res) {
        if (err) throw err
        cb()
        db.close()
      })
    })
  },

  getGuardChat: function (guardBot, MongoClient, url, cb) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('guard').findOne({name: 'guard'}, function (err, guard) {
        if (err) throw err
        if (guard) {
          cb(guard.chatId)
        }
        db.close()
      })
    })
  },

  storeGuardChat: function (chatId, MongoClient, url) {
    MongoClient.connect(url, function (err, db) {
      if (err) throw err
      db.collection('guard').update({name: 'guard'}, {name: 'guard', chatId: chatId}, {upsert: true}, function (err, res) {
        if (err) throw err
        db.close()
      })
    })
  },

  getLocalizedString: function (lang, key) {
    return JSON.parse(fs.readFileSync('./locales/' + lang + '.json', 'utf8'))[key]
  }
}
