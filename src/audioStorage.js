const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({});
const AUDIO_BUCKET_NAME = process.env.AUDIO_BUCKET_NAME;

/// Suno'nun (ya da başka bir dış servisin) geçici URL'inden ses dosyasını
/// indirir ve kalıcı olarak kendi S3 bucket'ımıza yazar. Suno'nun URL'leri
/// süreli/geçici olduğu için, kullanıcı bir şarkıyı kütüphanesine
/// KAYDETTİĞİ an bu kopyalama yapılmalı -- aksi halde birkaç gün/hafta
/// sonra kullanıcının kütüphanesindeki eski şarkılar da tıpkı videolardaki
/// "ExpiredToken" sorunu gibi sessizce açılmaz hale gelir.
///
/// Döndürdüğü "key", DB'ye YAZILACAK olan S3 object key'idir (URL değil).
///
/// GÜVENLİK (SORUN 2754 #13): sadece https ve en fazla MAX_AUDIO_BYTES --
/// 8 dakikalık 320 kbps bir mp3 ~20 MB, bu sınır fazlasıyla yeterli ve
/// Lambda belleğini dev bir dosyayla doldurmayı engeller.
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

async function copyExternalAudioToS3(externalUrl, userId, songId) {
  if (!/^https:\/\//i.test(externalUrl)) {
    throw new Error("Ses dosyası adresi geçersiz.");
  }
  const res = await fetch(externalUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`Ses dosyası indirilemedi (HTTP ${res.status}).`);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_AUDIO_BYTES) {
    throw new Error("Ses dosyası çok büyük.");
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error("Ses dosyası çok büyük.");
  }
  return uploadAudioBufferToS3(buffer, userId, songId);
}

/// YENİ (Lyria entegrasyonu): Suno'dan farklı olarak Lyria bize hazır bir
/// URL değil, doğrudan base64 ses BAYTLARINI döndürüyor -- indirilecek bir
/// dış URL yok. Bu yüzden copyExternalAudioToS3'ün "fetch" adımını atlayıp
/// doğrudan S3'e yazan bu küçük yardımcıyı ekliyoruz. Anahtar (key)
/// deseni copyExternalAudioToS3 ile BİREBİR aynı -- saveSong.js ve
/// getSongPlayUrl.js hangi ses sağlayıcısından geldiğini hiç bilmesine
/// gerek kalmadan çalışmaya devam eder.
async function uploadAudioBufferToS3(buffer, userId, songId) {
  const key = `songs/${userId}/${songId}.mp3`;
  await s3.send(
    new PutObjectCommand({
      Bucket: AUDIO_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "audio/mpeg",
    })
  );
  return key;
}

/// YENİ (Lyria entegrasyonu): Lyria job'ı "ready" olur olmaz -- kullanıcı
/// henüz kütüphanesine KAYDETMEDEN, sadece GeneratingScreen'de dinleyip
/// kütüphaneye eklerken -- oynatılabilir bir URL'e ihtiyaç var (Suno'da bu
/// rolü Suno'nun kendi geçici CDN URL'i oynuyordu). AudioBucket tamamen
/// private olduğu için (bkz. template.yaml PublicAccessBlockConfiguration),
/// burada kısa ömürlü (24 saatlik -- kullanıcının şarkıyı dinleyip
/// kaydetmesine fazlasıyla yetecek kadar) bir S3 presigned GET URL
/// üretiyoruz. Kullanıcı şarkıyı kütüphanesine kaydederse saveSong.js zaten
/// bu URL'den indirip KENDİ kalıcı key'ine tekrar kopyalayacak (Suno
/// akışıyla birebir aynı davranış).
async function getPresignedAudioUrl(key, expiresInSeconds = 60 * 60 * 24) {
  const command = new GetObjectCommand({ Bucket: AUDIO_BUCKET_NAME, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

module.exports = { copyExternalAudioToS3, uploadAudioBufferToS3, getPresignedAudioUrl };