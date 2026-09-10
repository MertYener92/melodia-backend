const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

const PLAN_LIMITS = {
  free: 2,
  basic_monthly: 20,
  pro_monthly: 60,
};

exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;

  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const plan = user?.plan || "free";
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const used = user?.usagePeriod === currentPeriod ? user.usageCount : 0;

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
