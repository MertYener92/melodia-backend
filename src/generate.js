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
const SONG_CREDIT_COST = Number(process.env.SONG_CREDIT_COST || 1);

// BİRLEŞİK JETON HAVUZU — melodia-video (createVideoProject.js) ve
// melodia-music-spec (app.py) ile AYNI alanları (aiCreditsUsed,
// aiCreditsPeriod) kullanıyor, aynı UsersTable üzerinde. Şarkı, video,
// music-spec artık tek bir "jeton" bakiyesinden düşüyor — eskiden burada
// ayrı bir "usageCount" sayacı vardı, o tamamen kaldırıldı.
//
// TAHMINI DEGERLER — gercek maliyetler netlestikce ayarlanabilir.
// Test asamasinda free plani pratik olarak sinirsiz.
const AI_CREDIT_LIMITS = {
  free: Number.MAX_SAFE_INTEGER,
  basic_monthly: 100,
  pro_monthly: 300,
};

async function checkCreditsAvailable(userId, cost) {
  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const plan = user?.plan || "free";
  const limit = AI_CREDIT_LIMITS[plan] ?? AI_CREDIT_LIMITS.free;
  const used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  return { allowed: used + cost <= limit, remaining: Math.max(limit - used, 0), used, currentPeriod };
}

async function deductCredits(userId, cost, used, currentPeriod) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId },
      UpdateExpression:
        "SET aiCreditsUsed = :newUsed, aiCreditsPeriod = :period, #plan = if_not_exists(#plan, :freePlan)",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: {
        ":newUsed": used + cost,
        ":period": currentPeriod,
        ":freePlan": "free",
      },
    })
  );
}

exports.handler = async (event) => {
  try {
    // 1) Kullanıcı kim? (Cognito token'ından otomatik gelir, taklit edilemez)
    const userId = event.requestContext.authorizer.claims.sub;

    // 2) JETON KONTROLÜ — Suno'ya hiç istek atmadan önce, asıl güvenlik burada
    const creditCheck = await checkCreditsAvailable(userId, SONG_CREDIT_COST);
    if (!creditCheck.allowed) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: "quota_exceeded",
          message: `Bu ayki jeton hakkınız yetersiz (kalan: ${creditCheck.remaining}, gereken: ${SONG_CREDIT_COST}).`,
        }),
      };
    }

    // 3) Kota uygunsa, isteği request body'den al ve Suno'ya ilet
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
      // Suno hata verdiyse kullanıcının jetonunu DÜŞÜRME — hakkı sende dursun
      console.error(
        `Suno generate hatası — HTTP ${sunoResponse.status}, cevap:`,
        JSON.stringify(sunoData)
      );
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "suno_error",
          message: sunoData.msg || "Şarkı üretimi başlatılamadı.",
        }),
      };
    }

    // 4) SADECE Suno isteği başarılı olduktan sonra jeton düşülür
    await deductCredits(userId, SONG_CREDIT_COST, creditCheck.used, creditCheck.currentPeriod);

    return {
      statusCode: 200,
      body: JSON.stringify({
        taskId: sunoData.data.taskId,
        remainingCredits: creditCheck.remaining - SONG_CREDIT_COST,
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