const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Your tokens
const PAGE_ACCESS_TOKEN = 'EAAUBZCxMBc3gBQqaaEwsnLAvhIwEUTgN3EHYnm0GCmHVaxAqGb7E4yJSKOfrhOMO8ZCV9T2qHZAEeQzZAYXQZBusEg9bQYiJpixsGFToWusTj4qCdWPS7M0i6q6P8JmramD4Oc3rF2oNZCx8wwBSZBDzyioNx0LTDgOZC0kFi6xZAbBZAoc0Smgwm49KoZCIW5TZCAaARxpMZAOKlEwLr5jKZCMZCve';
const VERIFY_TOKEN = 'my_secret_verify_token_12345';
const GEMINI_API_KEY = 'AIzaSyBx5Vuz65X-DL3QTiwwLEx8lGb9Y-Ai4W8';

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

// Receive messages - CRITICAL: Don't send response until AFTER processing
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body));

    if (body.object === 'page') {
      // Process all entries
      for (const entry of body.entry) {
        for (const event of entry.messaging) {
          if (event.message && event.message.text) {
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`Message from ${senderID}: ${userMessage}`);

            try {
              // Call Gemini API directly
              const aiReply = await callGeminiAPI(userMessage);
              console.log(`Gemini response: ${aiReply}`);

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

    // ONLY send response AFTER everything is done
    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// Function to call Gemini API directly
async function callGeminiAPI(userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: userMessage
        }]
      }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    return data.candidates[0].content.parts[0].text;
  }
  
  throw new Error('No response from Gemini');
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
  res.send('Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;