const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { verifyAndDecodeTransaction } = require("./appleIap");
const { creditsFromProductId } = require("./creditPackages");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 gün

// verifySubscription.js ile AYNI güvenlik deseni (imzalı makbuz + Apple'ın
// resmi kütüphanesiyle doğrulama + appAccountToken eşleşmesi), TEK farkla:
// tüketilebilir (consumable) satın almalar App Store'un kendi tarafında
// "restore" edilebilir/tekrar bildirilebilir olduğu için, aynı işlemin
// (transactionId) İKİ KEZ kredi eklemesini engellemek üzere
// IdempotencyTable üzerinden koşullu bir kilit alıyoruz.
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

    const credits = creditsFromProductId(transaction.productId);
    if (!credits) {
      console.error(`Bilinmeyen kredi paketi productId: ${transaction.productId}`);
      return { statusCode: 400, body: JSON.stringify({ error: "Bilinmeyen ürün." }) };
    }

    // İDEMPOTENCY: bu transactionId daha önce işlendiyse (Flutter'ın aynı
    // isteği tekrar göndermesi, Apple'ın restore akışı vb.) krediyi
    // İKİNCİ KEZ eklemeden, sadece güncel bakiyeyi döndür.
    const idempotencyKey = `credit-purchase:${transaction.transactionId}`;
    let alreadyProcessed = false;
    try {
      await client.send(
        new PutCommand({
          TableName: IDEMPOTENCY_TABLE_NAME,
          Item: {
            idempotencyKey,
            createdAt: new Date().toISOString(),
            expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(idempotencyKey)",
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        alreadyProcessed = true;
      } else {
        throw err;
      }
    }

    if (!alreadyProcessed) {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { userId },
          UpdateExpression: "ADD bonusCredits :credits SET updatedAt = :now",
          ExpressionAttributeValues: {
            ":credits": credits,
            ":now": new Date().toISOString(),
          },
        })
      );
    }

    const { Item: user } = await client.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        creditsAdded: alreadyProcessed ? 0 : credits,
        bonusCredits: user?.bonusCredits || 0,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
