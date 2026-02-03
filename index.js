const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Your tokens
const PAGE_ACCESS_TOKEN = 'EAAUBZCxMBc3gBQqaaEwsnLAvhIwEUTgN3EHYnm0GCmHVaxAqGb7E4yJSKOfrhOMO8ZCV9T2qHZAEeQzZAYXQZBusEg9bQYiJpixsGFToWusTj4qCdWPS7M0i6q6P8JmramD4Oc3rF2oNZCx8wwBSZBDzyioNx0LTDgOZC0kFi6xZAbBZAoc0Smgwm49KoZCIW5TZCAaARxpMZAOKlEwLr5jKZCMZCve';
const VERIFY_TOKEN = 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = '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';

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body));

    if (body.object === 'page') {
      for (const entry of body.entry) {
        for (const event of entry.messaging) {
          // Ignore echo messages
          if (event.message && event.message.text && !event.message.is_echo) {
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`Message from ${senderID}: ${userMessage}`);

            try {
              // Call DeepSeek V3.1 via OpenRouter (SMARTEST FREE MODEL)
              const aiReply = await callDeepSeekAPI(userMessage);
              console.log(`DeepSeek response: ${aiReply}`);

              // Send reply to Facebook
              await sendFacebookMessage(senderID, aiReply);
              console.log('Message sent successfully');

            } catch (error) {
              console.error('Error processing message:', error);
              await sendFacebookMessage(senderID, 'Sorry, I encountered an error. Please try again.');
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// Function to call DeepSeek V3.1 via OpenRouter (FREE!)
async function callDeepSeekAPI(userMessage) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://messenger-gemini-bot.vercel.app',  // Optional but recommended
      'X-Title': 'Messenger AI Bot'  // Optional but recommended
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3.1:free',  // LATEST FREE MODEL (V3.1 - SMARTEST!)
      messages: [{
        role: 'user',
        content: userMessage
      }],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No response from DeepSeek');
}

// Function to send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientID },
      message: { text: messageText }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Health check
app.get('/', (req, res) => {
  res.send('Bot is running with DeepSeek V3.1 - The smartest free AI!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;