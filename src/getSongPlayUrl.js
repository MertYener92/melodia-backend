const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { signMediaUrl } = require("./cloudfrontSigner");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;

// GET /songs/{songId}/play-url
// Video tarafındaki getPlayUrl.js ile aynı mantık: DB'de sabit URL
// saklamıyoruz, çalma anında taze, kısa ömürlü bir CloudFront signed URL
// üretiyoruz.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const songId = event.pathParameters.songId;

    const { Item: song } = await client.send(
      new GetCommand({ TableName: SONGS_TABLE_NAME, Key: { userId, songId } })
    );

    if (!song || !song.audioKey) {
      return { statusCode: 404, body: JSON.stringify({ error: "Şarkı bulunamadı." }) };
    }

    const expiresInSeconds = 60 * 60; // 1 saat
    const playUrl = await signMediaUrl(song.audioKey, expiresInSeconds);

    return {
      statusCode: 200,
      body: JSON.stringify({
        playUrl,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};