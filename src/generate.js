const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const SUNO_BASE_URL = "https://api.sunoapi.org";

// Paket tanımları: subscriptionTier -> aylık şarkı hakkı
// (App Store / Play Store'daki abonelik ürün ID'lerinle eşleştir)
//
// GEÇİCİ: Test aşamasında free planı sınırsız yaptık (Number.MAX_SAFE_INTEGER).
// Yayına almadan önce bunu tekrar makul bir sayıya (örn. 2) çevirmeyi unutma.
const PLAN_LIMITS = {
  free: Number.MAX_SAFE_INTEGER,
  basic_monthly: 20, // örn. 400 TL'lik paketin
  pro_monthly: 60,
};

exports.handler = async (event) => {
  try {
    // 1) Kullanıcı kim? (Cognito token'ından otomatik gelir, taklit edilemez)
    const userId = event.requestContext.authorizer.claims.sub;

    // 2) Kullanıcının mevcut kota kaydını çek
    const { Item: user } = await client.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
    );

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${now.getMonth() + 1}`; // "2026-9"

    const plan = user?.plan || "free";
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    // Yeni ay başladıysa sayaç sıfırlanmış gibi davran
    const usedThisPeriod =
      user?.usagePeriod === currentPeriod ? user.usageCount : 0;

    // 3) KOTA KONTROLÜ — asıl güvenlik burada, sunucu tarafında
    if (usedThisPeriod >= limit) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: "quota_exceeded",
          message: `Bu ayki ${limit} şarkı hakkınızı kullandınız. Yeni pakette devam edin.`,
        }),
      };
    }

    // 4) Kota uygunsa, isteği request body'den al ve Suno'ya ilet
    const body = JSON.parse(event.body || "{}");

    // Suno bu alanı zorunlu tutuyor; sonucu zaten /status ile polling
    // yaptığımız için kendi no-op callback uç noktamızı, gelen isteğin
    // kendi adresinden anlık olarak hesaplıyoruz (CloudFormation'da sabit
    // tanımlarsak döngüsel bağımlılık oluşur, bu yüzden runtime'da kuruyoruz).
    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback`;

    const sunoResponse = await fetch(`${SUNO_BASE_URL}/api/v1/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUNO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customMode: true,
        instrumental: body.instrumental ?? false,
        prompt: body.lyrics,
        style: body.style,
        title: body.title,
        model: "V5_5",
        callBackUrl,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const sunoData = await sunoResponse.json();

    if (!sunoResponse.ok || sunoData.code !== 200) {
      // Suno hata verdiyse kullanıcının kotasını DÜŞÜRME — hakkı sende dursun
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "suno_error",
          message: sunoData.msg || "Şarkı üretimi başlatılamadı.",
        }),
      };
    }

    // 5) SADECE başarılı istekte kota bir arttırılır (atomik update)
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression:
          "SET usageCount = if_not_exists(usageCount, :zero) + :one, usagePeriod = :period, #plan = if_not_exists(#plan, :freePlan)",
        ExpressionAttributeNames: {
          "#plan": "plan",
        },
        ExpressionAttributeValues: {
          ":one": 1,
          ":zero": 0,
          ":period": currentPeriod,
          ":freePlan": "free",
        },
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        taskId: sunoData.data.taskId,
        remainingQuota: limit - (usedThisPeriod + 1),
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "internal_error", message: err.message }),
    };
  }
};