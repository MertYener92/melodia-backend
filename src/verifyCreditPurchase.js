const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { verifyAndDecodeTransaction } = require("./appleIap");
const { creditsFromProductId } = require("./creditPackages");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;

// verifySubscription.js ile AYNI güvenlik deseni (imzalı makbuz + Apple'ın
// resmi kütüphanesiyle doğrulama + appAccountToken eşleşmesi), TEK farkla:
// tüketilebilir (consumable) satın almalar App Store'un kendi tarafında
// "restore" edilebilir/tekrar bildirilebilir olduğu için, aynı işlemin
// (transactionId) İKİ KEZ kredi eklemesini engellemek üzere
// IdempotencyTable üzerinden koşullu bir kilit alıyoruz.
//
// DÜZELTME (SORUN 2754 #3):
//  - Kilit kaydı artık SÜRESİZ (önceden 30 günlük TTL vardı -- kayıt silinince
//    aynı imzalı makbuz tekrar gönderilip jeton yeniden yüklenebiliyordu).
//  - Kilit ve jeton ekleme TEK transaction: önceden kilit yazılıp jeton
//    ekleme başarısız olursa kullanıcı parasını ödediği jetonu hiç alamıyordu
//    (tekrar denemesi de "zaten işlendi" diye reddediliyordu).
//  - Apple'ın iade ettiği (revocationDate dolu) makbuz jeton eklemez.
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

    if (transaction.revocationDate) {
      return { statusCode: 400, body: JSON.stringify({ error: "Bu satın alma iade edilmiş." }) };
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
    const now = new Date().toISOString();
    let alreadyProcessed = false;
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: IDEMPOTENCY_TABLE_NAME,
                Item: {
                  idempotencyKey,
                  userId,
                  productId: transaction.productId,
                  credits,
                  createdAt: now,
                  // BİLİNÇLİ: expiresAt YOK -- kayıt kalıcı olmalı.
                },
                ConditionExpression: "attribute_not_exists(idempotencyKey)",
              },
            },
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { userId },
                UpdateExpression: "ADD bonusCredits :credits SET updatedAt = :now",
                ExpressionAttributeValues: { ":credits": credits, ":now": now },
              },
            },
          ],
        })
      );
    } catch (err) {
      const firstReason = err.CancellationReasons?.[0]?.Code;
      if (err.name !== "TransactionCanceledException" || firstReason !== "ConditionalCheckFailed") {
        throw err;
      }
      alreadyProcessed = true;
      // Bu düzeltmeden ÖNCE yazılmış (30 günlük TTL'li) eski kayıtları da
      // kalıcı hale getir.
      await client.send(
        new UpdateCommand({
          TableName: IDEMPOTENCY_TABLE_NAME,
          Key: { idempotencyKey },
          UpdateExpression: "REMOVE expiresAt",
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
    return { statusCode: 500, body: JSON.stringify({ error: "Satın alma doğrulanamadı." }) };
  }
};
