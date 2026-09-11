const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

// BİRLEŞİK JETON HAVUZU — generate.js, createVideoProject.js ve app.py
// ile AYNI alanları (aiCreditsUsed, aiCreditsPeriod) okuyor. Eski ayrı
// "usageCount" (sadece şarkı) sistemi tamamen kaldırıldı.
//
// TAHMINI DEGERLER — gercek maliyetler netlestikce ayarlanabilir.
const AI_CREDIT_LIMITS = {
  free: Number.MAX_SAFE_INTEGER,
  basic_monthly: 100,
  pro_monthly: 300,
};

exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;

  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const plan = user?.plan || "free";
  const limit = AI_CREDIT_LIMITS[plan] ?? AI_CREDIT_LIMITS.free;
  const used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  return {
    statusCode: 200,
    body: JSON.stringify({
      plan,
      used,
      limit,
      remaining: limit - used,
    }),
  };
};