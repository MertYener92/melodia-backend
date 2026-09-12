const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { limitForPlan, currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

// DÜZELTME: Bu dosya daha önce kendi bağımsız (ve artık ESKİ/YANLIŞ)
// AI_CREDIT_LIMITS kopyasını kullanıyordu — pro_monthly'yi hâlâ 300
// sanıyordu, pro_weekly/pro_yearly'yi hiç tanımıyordu (bu ikisi için
// sessizce "free" limitine, yani pratik olarak sınırsıza düşüyordu).
// Artık generate.js ile AYNI ortak modülü (creditPlans.js) kullanıyor —
// bir daha birbirinden sapma riski yok.
exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;

  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  const isExpired = user?.planExpiresAt && new Date(user.planExpiresAt) < now;
  const plan = isExpired ? "free" : user?.plan || "free";

  const limit = limitForPlan(plan);
  const currentPeriod = currentPeriodKey(plan, now);
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