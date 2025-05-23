const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid');
require('dotenv').config(); // Carga las variables del .env

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

app.post('/webhook', async (req, res) => {
  const userMessage = req.body.Body;
  const fromNumber = req.body.From;

  const sessionId = uuid.v4();
  const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: userMessage,
        languageCode: 'es',
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    const reply = result.fulfillmentText || "No tengo una respuesta para eso.";

    const twiml = `
      <Response>
        <Message>${reply}</Message>
      </Response>
    `;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).send('Error procesando la solicitud');
  }
});

app.listen(port, () => {
  console.log(`Webhook de WhatsApp + Dialogflow escuchando en el puerto ${port}`);
});