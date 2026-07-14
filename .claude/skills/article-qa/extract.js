(() => {
  const og = (prop) => {
    const el = document.querySelector(`meta[property="og:${prop}"]`);
    return el ? el.content : null;
  };

  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.content : null;
  };

  return JSON.stringify({
    resolved_url: window.location.href,
    title: document.title || null,
    meta_description: meta("description"),
    og_type: og("type"),
    og_title: og("title"),
    og_description: og("description"),
    og_url: og("url"),
    canonical: [...document.querySelectorAll('link[rel="canonical"]')]
      .map(el => el.href),
    robots: meta("robots"),
    h1: [...document.querySelectorAll("h1")]
      .map(el => el.textContent.trim()),
    heading_outline: [...document.querySelectorAll("h2, h3")]
      .map(el => ({
        level: el.tagName.toLowerCase(),
        text: el.textContent.trim()
      })),
    links: [...document.querySelectorAll("a[href]")]
      .map(el => ({
        href: el.href,
        anchor: el.textContent.trim(),
        rel: el.rel || null,
        target: el.target || null
      }))
  });
})()
