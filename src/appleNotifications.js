const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { verifyAndDecodeNotification, verifyAndDecodeTransaction } = require("./appleIap");
const { planFromProductId } = require("./planMapping");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

// Apple'ın App Store Server Notifications V2 webhook'u. Kullanıcı
// uygulamayı hiç açmasa bile (ör. gece bir abonelik otomatik yenilenince
// ya da iade edilince) Apple burayı çağırır — GERÇEK ZAMANLI abonelik
// durumu için TEK güvenilir kaynak burası. verifySubscription.js sadece
// "satın alma anında hemen tepki ver" için var.
//
// Auth: NONE — sunoCallback.js'teki gibi Apple'ın sunucusu çağırıyor,
// giriş yapmış bir kullanıcı değil. AMA burada içerik gerçekten kritik:
// güvenlik, JWS imzasının Apple'ın resmi kütüphanesiyle doğrulanmasından
// geliyor — imza geçmezse hiçbir veri güncellenmiyor.
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const signedPayload = body.signedPayload;
    if (!signedPayload) {
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    let notification;
    try {
      notification = await verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      console.error("Apple bildirim imzası doğrulanamadı:", err);
      return { statusCode: 400, body: JSON.stringify({ error: "invalid_signature" }) };
    }

    const signedTransactionInfo = notification.data?.signedTransactionInfo;
    if (!signedTransactionInfo) {
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    const transaction = await verifyAndDecodeTransaction(signedTransactionInfo);
    const userId = transaction.appAccountToken;

    if (!userId) {
      console.error("Bildirimde appAccountToken yok, kullanıcı eşlenemedi.");
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    const type = notification.notificationType;

    if (type === "SUBSCRIBED" || type === "DID_RENEW") {
      const plan = planFromProductId(transaction.productId);
      if (plan) {
        await client.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { userId },
            UpdateExpression:
              "SET #plan = :plan, planExpiresAt = :expiresAt, originalTransactionId = :otid",
            ExpressionAttributeNames: { "#plan": "plan" },
            ExpressionAttributeValues: {
              ":plan": plan,
              ":expiresAt": new Date(transaction.expiresDate).toISOString(),
              ":otid": transaction.originalTransactionId,
            },
          })
        );
      } else {
        console.error(`Bildirimde bilinmeyen productId: ${transaction.productId}`);
      }
    } else if (
      type === "EXPIRED" ||
      type === "REFUND" ||
      type === "REVOKE" ||
      type === "GRACE_PERIOD_EXPIRED"
    ) {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { userId },
          UpdateExpression: "SET #plan = :free REMOVE planExpiresAt",
          ExpressionAttributeNames: { "#plan": "plan" },
          ExpressionAttributeValues: { ":free": "free" },
        })
      );
    } else {
      console.log(`İşlenmeyen Apple bildirim tipi: ${type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};