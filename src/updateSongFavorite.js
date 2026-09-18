const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;

// YENİ (kütüphane favori kalıcılığı): önceden favori durumu SADECE
// Flutter tarafında (bellekte) tutuluyordu -- uygulama kapanıp
// açıldığında kayboluyordu. saveSong.js'in yaptığı PutCommand'ı (ses
// dosyasını S3'e YENİDEN kopyalar) tekrar çağırmak yerine, sadece
// isFavorite alanını güncelleyen HAFİF bir UpdateCommand.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const songId = event.pathParameters?.songId;
    const body = JSON.parse(event.body || "{}");

    if (!songId || typeof body.isFavorite !== "boolean") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "songId ve isFavorite (boolean) zorunludur." }),
      };
    }

    await client.send(
      new UpdateCommand({
        TableName: SONGS_TABLE_NAME,
        Key: { userId, songId },
        UpdateExpression: "SET isFavorite = :fav",
        // Şarkı bu kullanıcıya ait değilse (ya da hiç yoksa) sessizce
        // 404 dönsün -- başkasının şarkısını favorileyemesin.
        ConditionExpression: "attribute_exists(songId)",
        ExpressionAttributeValues: { ":fav": body.isFavorite },
      })
    );

    return { statusCode: 200, body: JSON.stringify({ songId, isFavorite: body.isFavorite }) };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { statusCode: 404, body: JSON.stringify({ error: "Şarkı bulunamadı." }) };
    }
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
