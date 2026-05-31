import { useEffect, useState } from "react";

/**
 * Returns an "accent" RGB string sampled from `coverUrl`, or null if the
 * image can't be loaded (CORS, missing URL, network error). Implementation
 * draws the image into a tiny 8x8 canvas and averages the channels — enough
 * to colour-match a 2px border without pulling in a vibrancy library.
 *
 * Spotify CDN (i.scdn.co) sends `Access-Control-Allow-Origin: *`, so the
 * crossOrigin="anonymous" img is fine to read pixels from.
 */
export function useCoverColor(coverUrl) {
  const [color, setColor] = useState(null);

  useEffect(() => {
    if (!coverUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setColor(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          // Skip near-black pixels so a black bar doesn't drag the colour to gray
          if (data[i] + data[i + 1] + data[i + 2] < 30) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
        if (n === 0) {
          setColor(null);
          return;
        }
        setColor(`rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`);
      } catch {
        setColor(null);
      }
    };
    img.onerror = () => {
      if (!cancelled) setColor(null);
    };
    img.src = coverUrl;
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  return color;
}
