const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;

// Kullanıcının kütüphanesindeki tüm şarkıları döndürür (en yeni önce).
// Bu fonksiyon zaten Query kullanıyordu (userId partition key), Scan
// sorunu video tarafındaydı -- burada değişen tek şey "audioUrl" yerine
// "audioKey" döndürülmesi (bkz. saveSong.js). İstemci, şarkıyı çalmadan
// önce ayrıca GET /songs/{songId}/play-url çağırmalı.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;

    const { Items } = await client.send(
      new QueryCommand({
        TableName: SONGS_TABLE_NAME,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      })
    );

    const songs = (Items || []).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ songs }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};