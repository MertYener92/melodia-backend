const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

// YENİ (Profile ekranı — "Complete your profile" akışı): kullanıcının
// profilini KISMİ olarak günceller. quota.js'in aksine burada TEK bir
// UpdateCommand ile sadece body'de gönderilen alanlar yazılır -- flow'un
// her adımı kendi alanını gönderir, bu yüzden kullanıcı yarıda çıksa bile
// önceki adımlarda kaydedilen veri KAYBOLMAZ (her adım kendi PATCH'ini
// atıyor, tüm formu tek seferde göndermiyor).
//
// Kabul edilen alanlar (hepsi opsiyonel, en az biri zorunlu):
//   displayName    (string, 1-40 karakter)
//   avatarKey      (string) -- avatarUploadUrl.js ile S3'e yüklenen
//                    dosyanın key'i, ör: "avatars/<userId>/avatar.jpg"
//   favoriteGenres (string[], max 5)
//   moodPreference (string)
//   creationGoal   (string)
//   profileStep    (number, 0-4) -- akışın hangi adımında kalındığı;
//                    4 olduğunda profileCompleted otomatik true yazılır.
const ALLOWED_FIELDS = [
  "displayName",
  "avatarKey",
  "favoriteGenres",
  "moodPreference",
  "creationGoal",
  "profileStep",
];

exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const body = JSON.parse(event.body || "{}");

    const updates = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined && body[field] !== null) {
        updates[field] = body[field];
      }
    }

    if (updates.displayName !== undefined) {
      const trimmed = String(updates.displayName).trim().slice(0, 40);
      if (trimmed.length === 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "displayName boş olamaz." }),
        };
      }
      updates.displayName = trimmed;
    }

    // GÜVENLİK DÜZELTMESİ (SORUN 2754 #13): avatarKey sadece kullanıcının
    // KENDİ avatar klasörünü gösterebilir. Önceden serbestti -- /quota bu
    // anahtarı CloudFront ile imzaladığı için başka bir kullanıcının şarkı
    // dosyası (songs/<başkası>/...) için imzalı link alınabiliyordu.
    if (updates.avatarKey !== undefined) {
      const key = String(updates.avatarKey);
      if (!key.startsWith(`avatars/${userId}/`) || key.includes("..") || key.length > 200) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Geçersiz avatar." }),
        };
      }
      updates.avatarKey = key;
    }

    for (const field of ["moodPreference", "creationGoal"]) {
      if (updates[field] !== undefined) {
        updates[field] = String(updates[field]).slice(0, 100);
      }
    }

    if (updates.profileStep !== undefined) {
      const step = Number(updates.profileStep);
      if (!Number.isInteger(step) || step < 0 || step > 10) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Geçersiz profileStep." }),
        };
      }
      updates.profileStep = step;
    }

    if (updates.favoriteGenres !== undefined) {
      if (!Array.isArray(updates.favoriteGenres)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "favoriteGenres bir dizi olmalı." }),
        };
      }
      updates.favoriteGenres = updates.favoriteGenres
        .map((g) => String(g).slice(0, 40))
        .slice(0, 5);
    }

    if (Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Güncellenecek en az bir alan gönderilmelidir." }),
      };
    }

    // Adım 4'e ulaşıldıysa profil tamamlandı olarak işaretle -- bu
    // ekranın "Complete Your Profile" kartını tamamen gizlemesini sağlar.
    if (updates.profileStep !== undefined && Number(updates.profileStep) >= 4) {
      updates.profileCompleted = true;
    }

    const setExpressions = [];
    const values = {};
    const names = {};
    for (const [key, value] of Object.entries(updates)) {
      setExpressions.push(`#${key} = :${key}`);
      names[`#${key}`] = key;
      values[`:${key}`] = value;
    }

    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );

    return { statusCode: 200, body: JSON.stringify({ ...updates }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
