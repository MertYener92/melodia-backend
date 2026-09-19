const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { verifyAndDecodeNotification, verifyAndDecodeTransaction } = require("./appleIap");
const { planFromProductId } = require("./planMapping");
const { creditsFromProductId } = require("./creditPackages");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;

// YENİ (SORUN 2754 #12): iade edilen JETON PAKETİ (consumable). Önceden
// REFUND bildirimi ürün tipine bakmadan kullanıcıyı "free" plana düşürüyordu
// -- jeton paketi iadesi aboneliği iptal ediyor, iade edilen jetonlar ise
// kullanıcıda kalıyordu. Artık sadece o paketin jetonları düşülüyor (bakiye
// yetmiyorsa kalanı sıfırlanıyor), aynı iade iki kez işlenmiyor.
async function refundCreditPackage(userId, transaction, credits) {
  const refundKey = `credit-refund:${transaction.transactionId}`;
  const now = new Date().toISOString();
  const lockItem = {
    Put: {
      TableName: IDEMPOTENCY_TABLE_NAME,
      Item: { idempotencyKey: refundKey, userId, credits, createdAt: now },
      ConditionExpression: "attribute_not_exists(idempotencyKey)",
    },
  };

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          lockItem,
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { userId },
              UpdateExpression: "ADD bonusCredits :neg SET updatedAt = :now",
              ConditionExpression: "bonusCredits >= :credits",
              ExpressionAttributeValues: { ":neg": -credits, ":credits": credits, ":now": now },
            },
          },
        ],
      })
    );
    return;
  } catch (err) {
    if (err.name !== "TransactionCanceledException") throw err;
    const [lockReason] = (err.CancellationReasons || []).map((r) => r.Code);
    if (lockReason === "ConditionalCheckFailed") {
      console.log(`Jeton iadesi zaten işlenmiş: ${transaction.transactionId}`);
      return;
    }
  }

  // Jetonların bir kısmı zaten harcanmış: kalan bakiyeyi sıfırla.
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          lockItem,
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { userId },
              UpdateExpression: "SET bonusCredits = :zero, updatedAt = :now",
              ExpressionAttributeValues: { ":zero": 0, ":now": now },
            },
          },
        ],
      })
    );
  } catch (err) {
    if (err.name === "TransactionCanceledException") return; // eşzamanlı işlendi
    throw err;
  }
}

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
    const plan = planFromProductId(transaction.productId);
    const packageCredits = creditsFromProductId(transaction.productId);

    // Jeton paketi (consumable) -- abonelik alanlarına HİÇ dokunulmaz.
    if (packageCredits) {
      if (type === "REFUND" || type === "REVOKE") {
        await refundCreditPackage(userId, transaction, packageCredits);
      } else {
        console.log(`Jeton paketi için işlenmeyen bildirim tipi: ${type}`);
      }
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    if (!plan) {
      console.error(`Bildirimde bilinmeyen productId: ${transaction.productId}`);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    if (type === "SUBSCRIBED" || type === "DID_RENEW") {
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
    return { statusCode: 500, body: JSON.stringify({ error: "internal_error" }) };
  }
};
