#!/usr/bin/env python3
"""Génère public/decouvrir.html (FR) et public/en.html (EN) depuis un seul gabarit.
Usage : python3 -I design/landing.py  (depuis la racine du dépôt)
Liens à compléter : TESTFLIGHT_URL (puis App Store), CONTACT_EMAIL."""
import json, html
TESTFLIGHT_URL = "#"          # TODO : lien TestFlight public, puis lien App Store
CONTACT_EMAIL = ""            # TODO : adresse de contact publique
SITE = "https://dj-matcher.vercel.app"
T = {
"fr": dict(path="/decouvrir", other="/en", other_label="English", lang="fr", locale="fr_FR",
  title="DJ Matcher : le prochain morceau qui s'enchaîne",
  desc="DJ Matcher écoute ce qui passe et propose les prochains morceaux compatibles : BPM, tonalité Camelot, style. Gratuit, sans compte.",
  h1="Vous passez la musique ?<br>DJ Matcher vous souffle la suite.",
  sub="Shazam vous dit ce qui passe. DJ Matcher vous dit quoi passer ensuite, et pourquoi.",
  cta_ios="Tester sur iPhone", cta_web="Essayer dans le navigateur", cta_note="Gratuit · sans compte · sans pub · pas besoin d'être DJ",
  ios_pending="Lien de test iPhone bientôt disponible",
  how_t="Comment ça marche", how=[("Approchez l'iPhone de l'enceinte","Spotify, Deezer, Apple Music, un vinyle ou la playlist d'un ami : peu importe la source."),("Le morceau est reconnu","En quelques secondes, grâce à la reconnaissance musicale d'Apple. Le son n'est pas enregistré."),("La suite s'affiche, avec le pourquoi","Les titres qui s'enchaînent, classés : BPM proche, tonalité compatible, même style.")],
  ex_t="Un exemple réel", ex_lead="Après <b>One More Time</b> de Daft Punk (123 BPM, tonalité 10B), l'appli propose notamment :",
  ex=[("Aerodynamic","Daft Punk","123","10B","même tempo, même tonalité"),("Crazy In Love","Beyoncé feat. JAY-Z","121","10B","tempo à 2 BPM près, même tonalité")],
  ex_foot="Chaque suggestion porte ses indicateurs : BPM, clé, style, dansabilité. On voit pourquoi ça marche, on apprend en passant.",
  who_t="Pour qui", who=[("Celle ou celui qui met la musique ce soir","Anniversaire, mariage entre amis, apéro qui s'éternise, bar à tenir. Pas besoin de savoir mixer."),("Les DJ amateurs et les DJ mobiles","Un cerveau de secours quand la piste se vide ou qu'on vous demande un titre imprévu."),("Celles et ceux qui apprennent à mixer","La roue de Camelot sur de vrais morceaux, avec l'explication à chaque suggestion.")],
  shots_t="L'appli en images", shots=[("ecoute","Il écoute, il propose"),("suggestions","Les titres compatibles"),("filtres","Filtrer par style"),("favori","Vos favoris remontent"),("recherche","Ou tapez un titre")],
  feat_t="Ce qu'elle fait", feats=["Écoute automatique : le téléphone posé près de l'enceinte reconnaît le morceau toutes les dix secondes environ.","Un catalogue sélectionné d'environ 5 000 titres, chacun avec son BPM et sa tonalité, des années 1960 à aujourd'hui.","Pop, dance et house, rock, rap français et américain, variété, soul et funk, latino, reggae.","Favoris qui remontent dans le classement, titres à oublier, filtres par style et « Populaires ».","Pré-écoute en un geste dans Apple Music, Spotify ou Deezer.","Un titre inconnu ? Ajoutez-le : son BPM et sa tonalité sont recherchés automatiquement.","Favoris synchronisés entre iPhone et iPad via iCloud."],
  facts=[("5 050","titres avec BPM et tonalité"),("4","indicateurs par suggestion"),("0","compte, pub ou traceur"),("1","développeur, en France")],
  faq_t="Questions fréquentes", faq=[("Faut-il être DJ ?","Non. L'appli suggère, vous choisissez. Si vous savez ce qu'est une playlist, vous savez vous en servir."),("Ça marche avec Spotify, Deezer, un vinyle ?","Oui : l'iPhone écoute le son de la pièce, quelle que soit la source. Les liens de pré-écoute ouvrent Apple Music, Spotify ou Deezer."),("Est-ce que ça enregistre ce qui se dit ?","Non. Une empreinte acoustique est calculée sur l'iPhone pour reconnaître le morceau, puis le micro s'arrête. Rien n'est conservé."),("Et sur Android ou ordinateur ?","La version web fonctionne partout, avec la recherche par titre (sans l'écoute). Elle s'installe comme une appli depuis Chrome sur Android."),("Combien ça coûte ?","Rien. Pas d'abonnement, pas de publicité, pas de compte."),("Et si mon morceau n'est pas dans le catalogue ?","Ajoutez-le depuis l'appli : son BPM et sa tonalité sont recherchés automatiquement, et il profite ensuite à tout le monde.")],
  video_t="La démo en 40 secondes",
  foot_priv="Confidentialité", foot_contact="Contact", foot_made="Fait en France par Olivier Baudet", web_label="Version web"),
"en": dict(path="/en", other="/decouvrir", other_label="Français", lang="en", locale="en_GB",
  title="DJ Matcher: what to play next",
  desc="DJ Matcher hears what's playing and suggests the next tracks that mix well: BPM, Camelot key, style. Free, no account.",
  h1="Playing the music tonight?<br>DJ Matcher whispers what's next.",
  sub="Shazam tells you what's playing. DJ Matcher tells you what to play next, and why.",
  cta_ios="Try it on iPhone", cta_web="Try it in your browser", cta_note="Free · no account · no ads · no DJ skills needed",
  ios_pending="iPhone test link coming soon",
  how_t="How it works", how=[("Hold your iPhone near the speaker","Spotify, Deezer, Apple Music, vinyl or a friend's playlist: any source works."),("The track is recognised","In a few seconds, with Apple's music recognition. Audio is never recorded."),("What's next appears, with the why","Tracks that mix well, ranked: close BPM, compatible key, same style.")],
  ex_t="A real example", ex_lead="After Daft Punk's <b>One More Time</b> (123 BPM, key 10B), the app suggests, among others:",
  ex=[("Aerodynamic","Daft Punk","123","10B","same tempo, same key"),("Crazy In Love","Beyoncé feat. JAY-Z","121","10B","within 2 BPM, same key")],
  ex_foot="Every suggestion carries its indicators: BPM, key, style, danceability. You see why it works and learn as you go.",
  who_t="Who it's for", who=[("Whoever plays the music tonight","Birthdays, a friend's wedding, a long apéro, a bar. No mixing skills needed."),("Hobby and mobile DJs","A backup brain when the floor empties or someone requests something unexpected."),("Anyone learning to mix","The Camelot wheel on real songs, with an explanation for every suggestion.")],
  shots_t="Screens", shots=[("ecoute","It listens and suggests"),("suggestions","Compatible tracks"),("filtres","Filter by style"),("favori","Your favourites rise"),("recherche","Or type a song")],
  feat_t="What it does", feats=["Auto-listen: leave the phone by the speaker and it recognises the track about every ten seconds.","A curated catalogue of about 5,000 tracks, each with BPM and key, from the 1960s to today.","Pop, dance and house, rock, French and US rap, French chanson, soul and funk, Latin, reggae.","Favourites boosted in the ranking, tracks you can hide, style and 'Popular' filters.","One-tap preview in Apple Music, Spotify or Deezer.","Unknown track? Add it: its BPM and key are looked up automatically.","Favourites synced between iPhone and iPad through iCloud."],
  facts=[("5,050","tracks with BPM and key"),("4","indicators per suggestion"),("0","accounts, ads or trackers"),("1","developer, in France")],
  faq_t="FAQ", faq=[("Do I need to be a DJ?","No. The app suggests, you choose. If you can make a playlist, you can use it."),("Does it work with Spotify, Deezer, vinyl?","Yes: the iPhone listens to the room, whatever the source. Preview links open Apple Music, Spotify or Deezer."),("Does it record conversations?","No. An acoustic fingerprint is computed on the iPhone to recognise the track, then the microphone stops. Nothing is kept."),("Android or computer?","The web version works everywhere, with search by title (no listening). It installs like an app from Chrome on Android."),("How much is it?","Nothing. No subscription, no ads, no account."),("What if my track isn't in the catalogue?","Add it from the app: its BPM and key are looked up automatically, and everyone benefits."),("Is the app in English?","The interface is French today; the English version is on its way.")],
  video_t="The 40-second demo",
  foot_priv="Privacy", foot_contact="Contact", foot_made="Made in France by Olivier Baudet", web_label="Web version"),
}
CSS = """
:root{--bg:#0f1115;--bg2:#161922;--card:#1b1f29;--line:#2a2e39;--fg:#f4f4f7;--muted:#a3a7b0;--faint:#6b6f78;--brand:#7f77dd;--brand2:#534ab7;--ok:#4cc38a;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f7f6fb;--bg2:#efedf8;--card:#ffffff;--line:#dedbec;--fg:#17151f;--muted:#55526a;--faint:#7c7990;--brand:#5b52d6;--brand2:#463dbb;--ok:#1b7f4b;color-scheme:light}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--brand)}
.wrap{max-width:1040px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:18px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:var(--fg);text-decoration:none}
.logo img{width:34px;height:34px}
.lang{font-size:14px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:6px 12px}
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center;padding-block:28px 56px}
.hero>*{min-width:0}
h1{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;font-size:clamp(34px,5.4vw,56px);line-height:1.04;letter-spacing:-.025em;margin:0 0 18px;text-wrap:balance}
.sub{font-size:clamp(18px,2.2vw,21px);color:var(--muted);margin:0 0 28px;max-width:34ch}
.ctas{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 22px;border-radius:14px;font-weight:600;text-decoration:none;font-size:16px}
.btn.primary{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff}
.btn.secondary{border:1px solid var(--line);color:var(--fg);background:var(--card)}
.btn[aria-disabled=true]{opacity:.55;pointer-events:none}
.note{margin:16px 0 0;font-size:14px;color:var(--faint)}
.phone{justify-self:center;width:min(320px,80vw);border-radius:40px;border:3px solid var(--line);overflow:hidden;box-shadow:0 30px 80px rgba(83,74,183,.35)}
.phone img{display:block;width:100%;height:auto}
section{padding-block:44px;border-top:1px solid var(--line)}
h2{font-size:clamp(24px,3vw,32px);letter-spacing:-.015em;margin:0 0 22px;text-wrap:balance}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;counter-reset:s;list-style:none;padding:0;margin:0}
.steps li{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;min-width:0}
.steps li::before{counter-increment:s;content:counter(s);display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;font-weight:700;margin-bottom:10px}
.steps b,.who b{display:block;font-size:18px;margin-bottom:6px}
.steps span,.who span{color:var(--muted);font-size:15.5px}
.example{background:var(--bg2);border-radius:18px;padding:22px}
.example p{margin:0 0 14px;color:var(--muted)}
.tracks{display:grid;gap:10px}
.track{display:grid;grid-template-columns:52px 1fr auto;gap:14px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 14px}
.tile{width:52px;height:52px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:15px;line-height:1.05;text-align:center;background:linear-gradient(145deg,#a6306b,#6a281b)}
.tile small{display:block;font-weight:500;font-size:10px;opacity:.8}
.track .t{min-width:0}.track .t b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track .t span{color:var(--muted);font-size:14px}
.chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:rgba(76,195,138,.16);color:var(--ok);white-space:nowrap}
.why{margin:14px 0 0;font-size:14.5px;color:var(--faint)}
.who{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.who div{padding:4px 0;min-width:0}
.shots{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x mandatory}
.shots figure{margin:0;flex:0 0 200px;scroll-snap-align:start}
.shots img{width:200px;height:auto;border-radius:22px;border:1px solid var(--line);display:block}
.shots figcaption{font-size:14px;color:var(--muted);margin-top:8px;text-align:center}
.feats{columns:2;column-gap:36px;padding-left:20px;margin:0}
.feats li{break-inside:avoid;margin:0 0 10px;color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:28px}
.facts div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}
.facts b{display:block;font-size:30px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.facts span{font-size:14px;color:var(--muted)}
details{border-bottom:1px solid var(--line);padding:14px 0}
summary{cursor:pointer;font-weight:600;font-size:17px}
details p{color:var(--muted);margin:10px 0 0}
#video.is-pending{display:none}
video{width:min(360px,100%);border-radius:24px;display:block}
footer{padding-block:32px 48px;color:var(--faint);font-size:14px;display:flex;flex-wrap:wrap;gap:8px 20px;border-top:1px solid var(--line)}
footer a{color:var(--muted)}
:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
@media (max-width:760px){.hero{grid-template-columns:1fr;gap:28px}.steps,.who{grid-template-columns:1fr}.feats{columns:1}.facts{grid-template-columns:repeat(2,1fr)}.track{grid-template-columns:44px 1fr}.tile{width:44px;height:44px;font-size:13px}.chips{grid-column:1/-1;justify-content:flex-start}}
"""
def page(k):
    t = T[k]; e = html.escape
    ld = {"@context":"https://schema.org","@type":"SoftwareApplication","name":"DJ Matcher","applicationCategory":"MusicApplication","operatingSystem":"iOS 17.6+, Web","offers":{"@type":"Offer","price":"0","priceCurrency":"EUR"},"description":t["desc"],"url":SITE+t["path"],"inLanguage":t["lang"],"author":{"@type":"Person","name":"Olivier Baudet"}}
    ios_ready = TESTFLIGHT_URL != "#"
    ios_btn = (f'<a class="btn primary" href="{TESTFLIGHT_URL}" data-todo="testflight-link">{e(t["cta_ios"])}</a>' if ios_ready else f'<a class="btn primary" href="#" aria-disabled="true" data-todo="testflight-link" title="{e(t["ios_pending"])}">{e(t["cta_ios"])}</a>')
    steps = "".join(f"<li><b>{e(a)}</b><span>{e(b)}</span></li>" for a, b in t["how"])
    ex = "".join(f'<div class="track"><div class="tile">{c}<small>{b} BPM</small></div><div class="t"><b>{e(n)}</b><span>{e(ar)}</span></div><div class="chips"><span class="chip">BPM ✓</span><span class="chip">{"Clé" if k=="fr" else "Key"} ✓</span><span class="chip">{e(w)}</span></div></div>' for n, ar, b, c, w in t["ex"])
    who = "".join(f"<div><b>{e(a)}</b><span>{e(b)}</span></div>" for a, b in t["who"])
    shots = "".join(f'<figure><picture><source srcset="/screens/{s}.webp" type="image/webp"><img src="/screens/{s}.png" alt="{e(c)}" loading="lazy" width="200" height="435"></picture><figcaption>{e(c)}</figcaption></figure>' for s, c in t["shots"])
    feats = "".join(f"<li>{e(f)}</li>" for f in t["feats"])
    facts = "".join(f"<div><b>{e(a)}</b><span>{e(b)}</span></div>" for a, b in t["facts"])
    faq = "".join(f"<details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in t["faq"])
    contact = f'<a href="mailto:{CONTACT_EMAIL}">{e(t["foot_contact"])} : {e(CONTACT_EMAIL)}</a>' if CONTACT_EMAIL else f'<span data-todo="contact-email">{e(t["foot_contact"])} : bientôt</span>'
    return f"""<!doctype html>
<html lang="{t['lang']}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(t['title'])}</title>
<meta name="description" content="{e(t['desc'])}">
<link rel="canonical" href="{SITE}{t['path']}">
<link rel="alternate" hreflang="fr" href="{SITE}/decouvrir"><link rel="alternate" hreflang="en" href="{SITE}/en">
<meta property="og:type" content="website"><meta property="og:site_name" content="DJ Matcher">
<meta property="og:title" content="{e(t['title'])}"><meta property="og:description" content="{e(t['desc'])}">
<meta property="og:url" content="{SITE}{t['path']}"><meta property="og:image" content="{SITE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:locale" content="{t['locale']}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(t['title'])}"><meta name="twitter:description" content="{e(t['desc'])}"><meta name="twitter:image" content="{SITE}/og.png">
<meta name="theme-color" content="#0f1115">
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<header><a class="logo" href="{t['path']}"><img src="/favicon.svg" alt="" width="34" height="34">DJ Matcher</a><a class="lang" href="{t['other']}" hreflang="{'en' if k=='fr' else 'fr'}">{t['other_label']}</a></header>
<main>
<div class="hero"><div><h1>{t['h1']}</h1><p class="sub">{e(t['sub'])}</p><div class="ctas">{ios_btn}<a class="btn secondary" href="/">{e(t['cta_web'])}</a></div><p class="note">{e(t['cta_note'])}</p></div>
<div class="phone"><picture><source srcset="/screens/ecoute.webp" type="image/webp"><img src="/screens/ecoute.png" alt="{e(t['shots'][0][1])}" width="320" height="696"></picture></div></div>
<section><h2>{e(t['how_t'])}</h2><ol class="steps">{steps}</ol></section>
<section><h2>{e(t['ex_t'])}</h2><div class="example"><p>{t['ex_lead']}</p><div class="tracks">{ex}</div><p class="why">{e(t['ex_foot'])}</p></div></section>
<section><h2>{e(t['who_t'])}</h2><div class="who">{who}</div></section>
<section><h2>{e(t['shots_t'])}</h2><div class="shots">{shots}</div></section>
<section id="video"><h2>{e(t['video_t'])}</h2><video controls playsinline preload="none" poster="/screens/ecoute.png" src="/demo.mp4"></video></section>
<section><h2>{e(t['feat_t'])}</h2><ul class="feats">{feats}</ul><div class="facts">{facts}</div></section>
<section><h2>{e(t['faq_t'])}</h2>{faq}</section>
</main>
<footer><a href="/confidentialite">{e(t['foot_priv'])}</a><a href="/">{e(t['web_label'])}</a>{contact}<span>{e(t['foot_made'])} · 2026</span></footer>
</div>
</body>
</html>
"""
for k, out in (("fr", "public/decouvrir.html"), ("en", "public/en.html")):
    open(out, "w", encoding="utf-8").write(page(k)); print("wrote", out)
