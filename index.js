const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('uuid');
const sessionClient = require('./dialogflowClient');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const languageCode = 'es';

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const userMessage = req.body.Body;
  const sessionId = uuid.v4();
  const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: userMessage,
        languageCode: languageCode,
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;
    const reply = result.fulfillmentText || 'No tengo una respuesta para eso.';

    const twiml = `
      <Response>
        <Message>${reply}</Message>
      </Response>
    `;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Error al enviar mensaje a Dialogflow:', error);
    res.status(500).send('Error interno del servidor');
  }
});

app.listen(port, () => {
  console.log(`Servidor escuchando en puerto ${port}`);
});