// lib/klaviyo.js — minimal Klaviyo API helper.

const REVISION = "2024-10-15";

function headers() {
  return {
    Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    "Content-Type": "application/json",
    revision: REVISION,
  };
}

export async function getProfile(kid) {
  const res = await fetch(`https://a.klaviyo.com/api/profiles/${encodeURIComponent(kid)}`, {
    headers: headers(),
  });
  if (!res.ok) return null;
  return (await res.json()).data;
}

export async function setProperties(kid, properties) {
  return fetch(`https://a.klaviyo.com/api/profiles/${encodeURIComponent(kid)}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      data: { type: "profile", id: kid, attributes: { properties } },
    }),
  });
}

export async function trackEvent(kid, metricName, properties = {}, value) {
  return fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          metric: { data: { type: "metric", attributes: { name: metricName } } },
          profile: { data: { type: "profile", id: kid } },
          properties,
          ...(value !== undefined ? { value } : {}),
        },
      },
    }),
  });
}
