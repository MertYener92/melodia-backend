const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  DeleteCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

const USERS_TABLE = process.env.TABLE_NAME;
const SONGS_TABLE = process.env.SONGS_TABLE_NAME;
const AUDIO_BUCKET_NAME = process.env.AUDIO_BUCKET_NAME;
const VIDEO_PROJECTS_TABLE = process.env.VIDEO_PROJECTS_TABLE_NAME;
const VIDEO_BUCKET_NAME = process.env.VIDEO_BUCKET_NAME;
const USER_POOL_ID = process.env.USER_POOL_ID;

// Kullanıcının TÜM verisini kalıcı olarak siler: şarkılar (+ artık kendi
// S3'ümüzde duran ses dosyaları), video projeleri (+ S3'teki fotoğraf/video
// dosyaları), kota kaydı ve en sonunda Cognito hesabının kendisi.
// Apple App Store'un zorunlu tuttuğu "hesabımı sil" kuralı için gerekli.
//
// BİLİNÇLİ OLARAK SİLİNMEYEN BİR ŞEY VAR: melodia-free-trial-ledger
// tablosu (appleUserIdHash -> claimedAt). Bu tablo BURADA SİLİNMEMELİ --
// amacı tam olarak, hesap silinip AYNI Apple kimliğiyle yeniden
// kaydolunduğunda ücretsiz jetonun sessizce yeniden kazanılmasını
// ENGELLEMEK (bkz. creditReservation.js -> claimFreeTrialOrThrow).
// Apple'ın "hesabı sil" kuralına aykırı değil çünkü bu tabloda İSİM,
// E-POSTA ya da başka bir kişisel veri YOK -- sadece opak bir hash +
// zaman damgası.
exports.handler = async (event) => {
  try {
    const claims = event.requestContext.authorizer.claims;
    const userId = claims.sub;
    const username = claims["cognito:username"] || claims.email || userId;

    // 1) Kullanıcının tüm şarkılarını (DB + artık S3'teki ses dosyalarını) sil.
    const { Items: songs } = await client.send(
      new QueryCommand({
        TableName: SONGS_TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      })
    );
    await Promise.all(
      (songs || []).map(async (s) => {
        if (s.audioKey) {
          await s3
            .send(new DeleteObjectCommand({ Bucket: AUDIO_BUCKET_NAME, Key: s.audioKey }))
            .catch(() => {});
        }
        await client
          .send(new DeleteCommand({ TableName: SONGS_TABLE, Key: { userId, songId: s.songId } }))
          .catch(() => {});
      })
    );

    // 2) Kullanıcının tüm video klip projelerini (DynamoDB + S3) sil.
    const { Items: videoProjects } = await client.send(
      new ScanCommand({
        TableName: VIDEO_PROJECTS_TABLE,
        FilterExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      })
    );
    await Promise.all(
      (videoProjects || []).map(async (p) => {
        const keys = [];
        if (p.photoKeys?.front) keys.push(p.photoKeys.front);
        if (p.photoKeys?.left) keys.push(p.photoKeys.left);
        if (p.photoKeys?.right) keys.push(p.photoKeys.right);
        if (p.finalVideoKey) keys.push(p.finalVideoKey);

        await Promise.all(
          keys.map((k) =>
            s3
              .send(new DeleteObjectCommand({ Bucket: VIDEO_BUCKET_NAME, Key: k }))
              .catch(() => {})
          )
        );
        await client
          .send(new DeleteCommand({ TableName: VIDEO_PROJECTS_TABLE, Key: { projectId: p.projectId } }))
          .catch(() => {});
      })
    );

    // 3) Kullanıcının kota/plan kaydını sil.
    await client
      .send(new DeleteCommand({ TableName: USERS_TABLE, Key: { userId } }))
      .catch(() => {});

    // 4) En son: Cognito hesabının kendisini sil.
    await cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
    );

    return { statusCode: 200, body: JSON.stringify({ deleted: true }) };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Hesap silinirken bir hata oluştu." }),
    };
  }
};