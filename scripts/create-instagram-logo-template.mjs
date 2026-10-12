import path from "node:path";
import sharp from "sharp";

const referenceImage = path.resolve("scripts/assets/instagram-logo-reference.jpg");
const output = path.resolve("public/generated/instagram-district-logos/template.png");
const { data, info } = await sharp(referenceImage)
  .resize(1080, 1080)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

for (let y = 390; y < 710; y += 1) {
  const minX = y < 480 ? 180 : 0;
  for (let x = minX; x < info.width; x += 1) {
    const offset = (y * info.width + x) * info.channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (red > 150 && red - green > 25 && red - blue > 45) {
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
    }
  }
}

await sharp(data, { raw: info }).png({ compressionLevel: 9 }).toFile(output);
console.log(`Created ${output}`);
