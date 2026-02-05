const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

// Receive messages and postbacks
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received');

    if (body.object === 'page') {
      for (const entry of body.entry) {
        const pageID = entry.id;
        
        for (const event of entry.messaging) {
          // Handle regular messages
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`Message from ${senderID}: ${userMessage}`);

            try {
              sendTypingIndicator(senderID, true).catch(() => {});

              const aiReply = await callDeepSeekAPI(userMessage);
              console.log('AI response received');

              await sendFacebookMessage(senderID, aiReply);
              console.log('Message sent successfully');

            } catch (error) {
              console.error('Error:', error.message);
              try {
                await sendFacebookMessage(senderID, 'Sorry, I had trouble with that. Try again?');
              } catch (sendError) {
                console.error('Failed to send error:', sendError.message);
              }
            } finally {
              sendTypingIndicator(senderID, false).catch(() => {});
            }
          }
          
          // Handle button clicks (postbacks)
          else if (event.postback) {
            const senderID = event.sender.id;
            const payload = event.postback.payload;

            console.log(`Postback from ${senderID}: ${payload}`);

            try {
              let response = '';
              
              switch(payload) {
                case 'GET_STARTED':
                  response = "👋 Welcome! I'm your AI assistant. I can:\n\n✅ Answer questions\n✅ Provide information\n✅ Have intelligent conversations\n✅ Help with various topics\n\nJust type your question and I'll respond!";
                  break;
                  
                case 'ABOUT_BOT':
                  response = "🤖 I'm an AI assistant powered by DeepSeek R1T2 Chimera, one of the most advanced AI models.\n\nI can help with:\n• General knowledge\n• Explanations\n• Problem-solving\n• Creative writing\n• And much more!\n\nWhat would you like to know?";
                  break;
                  
                case 'START_CHAT':
                  response = "💬 Great! I'm ready to chat. Ask me anything you'd like to know!";
                  break;
                  
                case 'HELP':
                  response = "🆘 **How to use me:**\n\n1️⃣ Just type your question\n2️⃣ I'll respond with helpful information\n3️⃣ You can ask follow-up questions\n\n**Tips:**\n• Be specific for better answers\n• I can't access real-time info (sports scores, news)\n• I'm here 24/7!\n\nWhat can I help you with?";
                  break;
                  
                case 'MAIN_MENU':
                  response = "🏠 **Main Menu**\n\nWhat would you like to do?\n\n• Ask me a question\n• Learn what I can do\n• Get help using the bot\n\nJust type your message!";
                  break;
                  
                default:
                  response = "I'm here to help! What would you like to know?";
              }
              
              await sendFacebookMessage(senderID, response);
              console.log('Postback response sent');

            } catch (error) {
              console.error('Error handling postback:', error.message);
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// Typing indicator
async function sendTypingIndicator(recipientID, isTyping) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
  } catch (error) {
    // Ignore
  }
}

// Call DeepSeek API
async function callDeepSeekAPI(userMessage) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad'
  });

  const systemPrompt = `You are a helpful AI assistant. Today is ${dateStr}, ${timeStr} (Iraq time).

Keep responses SHORT and conversational. If asked about real-time info (sports scores, news), politely say you can't access live data.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://messenger-gemini-bot.vercel.app',
      'X-Title': 'Messenger AI Bot'
    },
    body: JSON.stringify({
      model: 'tngtech/deepseek-r1t2-chimera:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No AI response');
}

// Send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientID },
      message: { text: messageText }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook error: ${response.status}`);
  }

  return await response.json();
}

// Health check
app.get('/', (req, res) => {
  res.send('🤖 AI Bot - DeepSeek R1T2 Chimera');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;