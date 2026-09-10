const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;
const AUDIO_BUCKET_NAME = process.env.AUDIO_BUCKET_NAME;

// DELETE /songs/{songId}
// Kullanıcının kütüphanesindeki bir şarkıyı kalıcı olarak siler:
// DynamoDB kaydı + (varsa) S3'teki ses dosyası. Eski (bu sistem
// öncesi kaydedilmiş) şarkılarda audioKey olmayabilir -- bu durumda
// sadece DB kaydı silinir, S3 silme adımı sessizce atlanır.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const songId = event.pathParameters.songId;

    const { Item: song } = await client.send(
      new GetCommand({ TableName: SONGS_TABLE_NAME, Key: { userId, songId } })
    );

    if (!song) {
      return { statusCode: 404, body: JSON.stringify({ error: "Şarkı bulunamadı." }) };
    }

    if (song.audioKey) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: AUDIO_BUCKET_NAME, Key: song.audioKey }))
        .catch(() => {}); // dosya zaten yoksa/erişilemezse akışı bozma
    }

    await client.send(
      new DeleteCommand({ TableName: SONGS_TABLE_NAME, Key: { userId, songId } })
    );

    return { statusCode: 200, body: JSON.stringify({ deleted: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};