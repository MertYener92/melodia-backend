# deploy-backend.ps1
#
# ONCE ASAGIDAKI 2 YERI KENDI DEGERLERINLE DOLDUR:
#   1) $stackName -> samconfig.toml'daki mevcut stack adin
#   2) $appleBundleId -> mevcut Apple Bundle ID'n (degismediyse ayni kalabilir)
#
# NOT: AnthropicApiKey/FalApiKey bu stack'te YOK -- SunoApiKey zaten
# Secrets Manager'dan resolve ediliyor (template.yaml icinde
# '{{resolve:secretsmanager:melodia/suno-api-key}}' ile), o yuzden
# burada ayrica sormuyoruz.
#
# Calistirma (melodia-backend\melodia-backend klasorunun icinden):
#   .\deploy-backend.ps1

$ErrorActionPreference = "Stop"

# ---- BURAYI DOLDUR ----
$stackName     = "melodia-backend"          # ornek: melodia-backend
$appleBundleId = "com.mertyener.melodia"                  # degismediyse dokunma
# ------------------------

$publicKeyPem = "$(Get-Content -Raw -Path '.\..\..\audio-public-key.pem')"

$parameters = [ordered]@{
    AppleBundleId                 = $appleBundleId
    CloudFrontPublicKeyPem        = $publicKeyPem
    CloudFrontPrivateKeySecretArn = "arn:aws:secretsmanager:eu-north-1:251538491179:secret:melodia/audio-cloudfront-private-key-8dsJer"
}

foreach ($key in $parameters.Keys) {
    if ($parameters[$key] -like "BURAYA_*") {
        Write-Error "Doldurulmamis bir placeholder var: $key. Script'in ustundeki alanlari doldurup tekrar calistir."
        exit 1
    }
}

$parametersFile = "params.yaml"
$parameters | ConvertTo-Json -Depth 5 | Out-File -FilePath $parametersFile -Encoding ascii -NoNewline

Write-Host "Deploy başlıyor... (birkaç dakika sürebilir, CloudFront adımı 5-20 dk alabilir)"

sam deploy `
    --template-file .aws-sam\build\template.yaml `
    --stack-name $stackName `
    --region eu-north-1 `
    --capabilities CAPABILITY_IAM `
    --parameter-overrides "file://$parametersFile" `
    --resolve-s3 `
    --no-confirm-changeset `
    --no-fail-on-empty-changeset

Remove-Item $parametersFile
