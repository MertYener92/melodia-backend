const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { verifyAndDecodeTransaction } = require("./appleIap");
const { planFromProductId } = require("./planMapping");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

// Flutter, StoreKit 2 ile satın alma tamamlandığında burayı çağırır — bu,
// kullanıcının BEKLEMEDEN pro olmasını sağlayan hızlı yol. Asıl güvenilir
// kaynak appleNotifications.js'teki webhook, ama satın alma anında hemen
// tepki vermek için bu da gerekiyor.
//
// GÜVENLİK — ASLA istemcinin "ben pro oldum" demesine güvenmiyoruz. İmzalı
// makbuzu (JWS) Apple'ın resmi kütüphanesiyle doğruluyoruz VE makbuzun
// içindeki appAccountToken'ın giriş yapmış kullanıcıyla eşleştiğini
// kontrol ediyoruz. ÖNEMLİ (Flutter tarafı): satın alma isteği atılırken
// appAccountToken olarak Cognito 'sub' değeri (bu kullanıcının userId'si)
// Apple'a gönderilmek ZORUNDA — aksi halde bu eşleşme hiç geçmez.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const body = JSON.parse(event.body || "{}");
    const signedTransactionInfo = body.signedTransactionInfo;

    if (!signedTransactionInfo) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "signedTransactionInfo gerekli." }),
      };
    }

    let transaction;
    try {
      transaction = await verifyAndDecodeTransaction(signedTransactionInfo);
    } catch (err) {
      console.error("Apple imza doğrulaması başarısız:", err);
      return { statusCode: 400, body: JSON.stringify({ error: "Makbuz doğrulanamadı." }) };
    }

    if (!transaction.appAccountToken || transaction.appAccountToken !== userId) {
      console.error(
        `appAccountToken uyuşmazlığı — beklenen ${userId}, gelen ${transaction.appAccountToken}`
      );
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Bu makbuz bu kullanıcıya ait değil." }),
      };
    }

    const plan = planFromProductId(transaction.productId);
    if (!plan) {
      console.error(`Bilinmeyen Apple productId: ${transaction.productId}`);
      return { statusCode: 400, body: JSON.stringify({ error: "Bilinmeyen ürün." }) };
    }

    const planExpiresAt = new Date(transaction.expiresDate).toISOString();

    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression:
          "SET #plan = :plan, planExpiresAt = :expiresAt, originalTransactionId = :otid",
        ExpressionAttributeNames: { "#plan": "plan" },
        ExpressionAttributeValues: {
          ":plan": plan,
          ":expiresAt": planExpiresAt,
          ":otid": transaction.originalTransactionId,
        },
      })
    );

    return { statusCode: 200, body: JSON.stringify({ plan, planExpiresAt }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};