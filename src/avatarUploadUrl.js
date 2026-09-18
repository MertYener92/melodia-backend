const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({});
const AUDIO_BUCKET_NAME = process.env.AUDIO_BUCKET_NAME;

// YENİ (Profile ekranı — avatar yükleme): audioStorage.js'deki
// getPresignedAudioUrl ile AYNI desen, ama ters yönde (GET yerine PUT) --
// Flutter, image_picker ile seçtiği fotoğrafı önce buradan aldığı
// presigned URL'e DOĞRUDAN yükler (backend'den geçmez, dosya boyutu API
// Gateway'in 10MB limitine takılmaz), sonra dönen "key"i
// PATCH /profile isteğinde avatarKey olarak gönderir.
//
// AYNI AudioBucket kullanılıyor (yeni bir bucket açmaya gerek yok) --
// sadece farklı bir prefix ("avatars/" yerine "songs/"). Bkz.
// template.yaml: AudioBucketPolicy'nin Resource'u avatars/* için de
// genişletildi ki CloudFront bu prefix'i de servis edebilsin.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const key = `avatars/${userId}/avatar.jpg`;

    const command = new PutObjectCommand({
      Bucket: AUDIO_BUCKET_NAME,
      Key: key,
      ContentType: "image/jpeg",
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      body: JSON.stringify({ uploadUrl, key }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
