const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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
async function copyExternalAudioToS3(externalUrl, userId, songId) {
  const res = await fetch(externalUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`Ses dosyası indirilemedi (HTTP ${res.status}).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

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

module.exports = { copyExternalAudioToS3 };