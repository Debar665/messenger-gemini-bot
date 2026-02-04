const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Conversation memory (stores last few messages per user)
const conversationMemory = new Map();

// Get conversation history for a user
function getConversationHistory(userId) {
  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, []);
  }
  return conversationMemory.get(userId);
}

// Add message to conversation history
function addToHistory(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content, timestamp: Date.now() });
  
  // Keep only last 10 messages
  if (history.length > 10) {
    history.shift();
  }
}

// Clean old conversations (older than 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [userId, history] of conversationMemory.entries()) {
    const filtered = history.filter(msg => msg.timestamp > oneHourAgo);
    if (filtered.length === 0) {
      conversationMemory.delete(userId);
    } else {
      conversationMemory.set(userId, filtered);
    }
  }
}, 10 * 60 * 1000); // Clean every 10 minutes

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

            try {
              sendTypingIndicator(senderID, true).catch(() => {});

              // Check for real-time data needs
              const realtimeData = await checkAndGetRealtimeData(userMessage);
              
              // Get AI response with conversation history
              const aiReply = await callAI(senderID, userMessage, realtimeData);

              await sendFacebookMessage(senderID, aiReply);

            } catch (error) {
              console.error('Error:', error.message);
              try {
                const errorResponses = [
                  "Oops, something went wrong on my end. Mind trying that again?",
                  "Sorry, I hit a snag there. Could you rephrase that?",
                  "Hmm, I'm having a moment. Can you ask me that again?",
                ];
                const randomError = errorResponses[Math.floor(Math.random() * errorResponses.length)];
                await sendFacebookMessage(senderID, randomError);
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

            try {
              let response = '';
              
              switch(payload) {
                case 'GET_STARTED':
                  response = "👋 Hey there! I'm your AI companion powered by the latest 2026 technology.\n\nI can help you with:\n✨ Real-time weather & sports\n💬 Smart conversations\n🌍 Current info & news\n📊 Quick facts & explanations\n\nWhat's on your mind?";
                  break;
                  
                case 'ABOUT_BOT':
                  response = "🤖 I'm running on cutting-edge AI from 2026!\n\nI combine:\n• Advanced language understanding\n• Real-time data access\n• Context-aware responses\n• Natural conversations\n\nI remember our chat context and get smarter with each conversation. Ask me anything!";
                  break;
                  
                case 'START_CHAT':
                  response = "Perfect! 😊 I'm all ears. What would you like to talk about or know?";
                  break;
                  
                case 'HELP':
                  response = "🆘 **Here's how I work:**\n\nJust talk to me naturally! I can:\n• Check weather anywhere 🌤️\n• Get sports scores ⚽\n• Answer questions 💡\n• Have real conversations 💬\n• Remember our chat context 🧠\n\nNo special commands needed - just ask!\n\nWhat interests you?";
                  break;
                  
                case 'MAIN_MENU':
                  response = "🏠 Main Menu\n\nPopular things to try:\n• \"Weather in [city]\"\n• \"[Team name] score\"\n• \"Tell me about...\"\n• \"What's new with...\"\n\nOr just chat with me about anything! 😊";
                  break;
                  
                default:
                  response = "I'm here and ready to help! What's up? 😊";
              }
              
              await sendFacebookMessage(senderID, response);

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

// Check if user is asking for real-time data and fetch it
async function checkAndGetRealtimeData(message) {
  const lowerMsg = message.toLowerCase();
  
  // Weather detection
  const weatherKeywords = ['weather', 'temperature', 'forecast', 'hot', 'cold', 'rain', 'sunny', 'climate', 'degrees'];
  if (weatherKeywords.some(keyword => lowerMsg.includes(keyword))) {
    const cityMatch = extractCity(message);
    if (cityMatch) {
      const weatherData = await getWeatherData(cityMatch);
      if (weatherData) return weatherData;
    }
  }
  
  // Sports detection
  const sportsKeywords = ['score', 'game', 'match', 'league', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'premier league', 'won', 'lost', 'team'];
  if (sportsKeywords.some(keyword => lowerMsg.includes(keyword))) {
    const sportsData = await getSportsData(lowerMsg);
    if (sportsData) return sportsData;
  }
  
  return null;
}

// Extract city name from message
function extractCity(message) {
  const patterns = [
    /weather (?:in|for|at|of) ([a-zA-Z\s]+)/i,
    /temperature (?:in|for|at|of) ([a-zA-Z\s]+)/i,
    /forecast (?:in|for|at|of) ([a-zA-Z\s]+)/i,
    /(?:what's|how's|whats|hows) (?:the )?weather (?:in|at|of) ([a-zA-Z\s]+)/i,
    /([a-zA-Z\s]+) weather/i,
  ];
  
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return null;
}

// Get weather data using Open-Meteo (completely free!)
async function getWeatherData(city) {
  try {
    // Geocode the city
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();
    
    if (!geoData.results || geoData.results.length === 0) {
      return null;
    }
    
    const location = geoData.results[0];
    const { latitude, longitude, name, country } = location;
    
    // Get weather data
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;
    const weatherResponse = await fetch(weatherUrl);
    const weatherData = await weatherResponse.json();
    
    const current = weatherData.current;
    const daily = weatherData.daily;
    const weatherCode = getWeatherDescription(current.weather_code);
    const windDirection = getWindDirection(current.wind_direction_10m);
    
    return {
      type: 'weather',
      data: {
        location: `${name}, ${country}`,
        temperature: Math.round(current.temperature_2m),
        feels_like: Math.round(current.apparent_temperature),
        humidity: current.relative_humidity_2m,
        wind_speed: Math.round(current.wind_speed_10m),
        wind_direction: windDirection,
        condition: weatherCode,
        high: Math.round(daily.temperature_2m_max[0]),
        low: Math.round(daily.temperature_2m_min[0]),
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Weather API error:', error);
    return null;
  }
}

// Get sports data using TheSportsDB - with limitations noted
async function getSportsData(query) {
  try {
    const sportsDbKey = '3'; // Free tier key
    
    // Check for specific team mentions
    const teamPatterns = [
      /lakers?/i, /warriors?/i, /celtics?/i, /heat/i, /bulls?/i, 
      /knicks?/i, /nets?/i, /sixers?/i, /clippers?/i, /bucks?/i,
      /barcelona/i, /real madrid/i, /manchester/i, /liverpool/i, /chelsea/i
    ];
    
    let teamName = null;
    for (const pattern of teamPatterns) {
      const match = query.match(pattern);
      if (match) {
        teamName = match[0];
        break;
      }
    }
    
    if (teamName) {
      // Search for the team
      const url = `https://www.thesportsdb.com/api/v1/json/${sportsDbKey}/searchteams.php?t=${encodeURIComponent(teamName)}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.teams && data.teams.length > 0) {
        const team = data.teams[0];
        
        // Get latest events for this team
        const eventsUrl = `https://www.thesportsdb.com/api/v1/json/${sportsDbKey}/eventslast.php?id=${team.idTeam}`;
        const eventsResponse = await fetch(eventsUrl);
        const eventsData = await eventsResponse.json();
        
        if (eventsData.results && eventsData.results.length > 0) {
          const latestEvent = eventsData.results[0];
          
          // Only return if we have actual scores (not future matches)
          if (latestEvent.intHomeScore !== null && latestEvent.intAwayScore !== null) {
            return {
              type: 'sports',
              data: {
                team: team.strTeam,
                league: team.strLeague,
                sport: team.strSport,
                latest_game: {
                  event: latestEvent.strEvent,
                  date: latestEvent.dateEvent,
                  home_team: latestEvent.strHomeTeam,
                  away_team: latestEvent.strAwayTeam,
                  home_score: latestEvent.intHomeScore,
                  away_score: latestEvent.intAwayScore,
                  status: latestEvent.strStatus
                },
                note: "This data may be delayed. For live scores, check official sources."
              }
            };
          }
        }
      }
    }
    
    // No valid data found - return null so AI doesn't make things up
    return null;
    
  } catch (error) {
    console.error('Sports API error:', error);
    return null;
  }
}

// Convert weather code to description
function getWeatherDescription(code) {
  const weatherCodes = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
  };
  return weatherCodes[code] || 'Unknown';
}

// Convert wind direction degrees to cardinal direction
function getWindDirection(degrees) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(degrees / 45) % 8;
  return directions[index];
}

// Call AI with conversation history and context
async function callAI(userId, userMessage, realtimeData = null) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  // Get current date and time (dynamic, updates every request)
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
    hour12: true,
    timeZone: 'Asia/Baghdad'
  });
  const hourOfDay = now.getHours();

  // Determine greeting based on time
  let timeGreeting = '';
  if (hourOfDay >= 5 && hourOfDay < 12) timeGreeting = 'morning';
  else if (hourOfDay >= 12 && hourOfDay < 17) timeGreeting = 'afternoon';
  else if (hourOfDay >= 17 && hourOfDay < 21) timeGreeting = 'evening';
  else timeGreeting = 'night';

  // Build dynamic system prompt
  let systemPrompt = `You are a helpful, friendly, and intelligent AI assistant in 2026. 

Current date and time: ${dateStr}, ${timeStr} (Iraq/Baghdad time)
Time of day: ${timeGreeting}

Your personality:
- Warm, conversational, and helpful
- Use natural language, not robotic
- Add appropriate emojis when it feels natural
- Remember context from the conversation
- Be concise but thorough
- Show genuine interest in helping

CRITICAL RULES:
- NEVER make up sports scores, fixtures, or player statistics
- NEVER invent match results or dates
- If you don't have real-time sports data, be honest and say so
- Suggest users check official sources like ESPN, BBC Sport, or team websites for accurate scores
- Only provide sports information if it's explicitly given in the real-time data below
- For weather, you can use the provided real-time data confidently
- Be accurate and honest about what you know and don't know

Guidelines:
- Keep responses conversational and engaging
- Vary your responses - don't use the same phrases repeatedly
- If you have real-time data, use it naturally in your response
- For current events beyond your knowledge, suggest checking latest sources
- Make responses feel personal and contextual`;

  // Add real-time data context if available
  if (realtimeData) {
    if (realtimeData.type === 'weather') {
      const w = realtimeData.data;
      systemPrompt += `\n\n🌤️ REAL-TIME WEATHER DATA (just fetched):\nLocation: ${w.location}\nCurrent: ${w.temperature}°C (feels like ${w.feels_like}°C)\nCondition: ${w.condition}\nHumidity: ${w.humidity}%\nWind: ${w.wind_speed} km/h from ${w.wind_direction}\nToday's High/Low: ${w.high}°C / ${w.low}°C\n\nUse this fresh data to give a natural, helpful response. Add context about what this weather means (e.g., "Perfect for a walk!" or "Stay warm!").`;
    } else if (realtimeData.type === 'sports') {
      const s = realtimeData.data;
      if (s.latest_game) {
        systemPrompt += `\n\n⚽ REAL-TIME SPORTS DATA (may be delayed):\nTeam: ${s.team}\nLeague: ${s.league}\nLatest Game: ${s.latest_game.event}\nDate: ${s.latest_game.date}\nScore: ${s.latest_game.home_team} ${s.latest_game.home_score} - ${s.latest_game.away_score} ${s.latest_game.away_team}\nStatus: ${s.latest_game.status}\n\nIMPORTANT: This is the ONLY sports data available. Do NOT invent or predict future fixtures, upcoming matches, or player statistics. If asked about future games or other details, politely suggest checking ${s.team}'s official website or ESPN/BBC Sport.`;
      } else {
        systemPrompt += `\n\nSports data was requested but not available from the API. Politely tell the user you don't have access to live sports scores right now and suggest they check ESPN, BBC Sport, or the team's official website for accurate, up-to-date information.`;
      }
    }
  }

  // Get conversation history
  const history = getConversationHistory(userId);
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Add recent conversation context (last 6 messages)
  const recentHistory = history.slice(-6);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }

  // Add current user message
  messages.push({ role: 'user', content: userMessage });

  // Call the latest AI models from 2026
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://messenger-bot-2026.vercel.app',
      'X-Title': 'Messenger AI Bot 2026'
    },
    body: JSON.stringify({
      // Using the best free model auto-router from 2026
      model: 'openrouter/free', // Auto-selects best free model: Trinity-Large, DeepSeek V3.2, GLM-4.5, etc.
      messages: messages,
      temperature: 0.8, // Slightly higher for more natural, varied responses
      max_tokens: 1200,
      top_p: 0.9
    })
  });

  if (!response.ok) {
    throw new Error(`AI error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    const aiReply = data.choices[0].message.content;
    
    // Add to conversation history
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', aiReply);
    
    return aiReply;
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
    throw new Error(`Facebook error: ${response.status}`);
  }

  return await response.json();
}

// Health check
app.get('/', (req, res) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  res.send(`🤖 Intelligent AI Bot 2026 - Running on ${dateStr}\n\nPowered by latest AI technology with real-time data access.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Intelligent Bot running on port ${PORT}`);
  console.log(`📅 Date: ${new Date().toLocaleDateString('en-US')}`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Baghdad' })}`);
});

module.exports = app;