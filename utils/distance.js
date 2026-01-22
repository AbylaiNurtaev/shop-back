const https = require('https');

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function extractCoordinatesFromUrl(url) {
  if (!url) return null;
  const regex = /([0-9]+\.[0-9]+)(?:,|%2C)([0-9]+\.[0-9]+)/;
  const match = String(url).match(regex);
  if (!match) return null;
  return {
    lon: parseFloat(match[1]),
    lat: parseFloat(match[2])
  };
}

function resolveShortUrl(url) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: 'HEAD' }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(res.headers.location);
      }
      return resolve(url);
    })
      .on('error', reject)
      .end();
  });
}

function normalizeLocationLink(link) {
  if (!link) return null;
  if (typeof link === 'string') return link;
  if (typeof link === 'object' && typeof link.link === 'string') return link.link;
  return null;
}

async function getCoordinatesFromLink(link) {
  const normalizedLink = normalizeLocationLink(link);
  if (!normalizedLink) return null;
  let finalUrl = normalizedLink;
  if (String(normalizedLink).includes('go.2gis.com')) {
    try {
      finalUrl = await resolveShortUrl(normalizedLink);
    } catch (error) {
      return null;
    }
  }
  return extractCoordinatesFromUrl(finalUrl);
}

async function findNearestStores(stores, userLat, userLng, limit = 10) {
  const results = [];
  for (const store of stores || []) {
    const coords = await getCoordinatesFromLink(store.location);
    if (!coords) continue;
    const distanceMeters = calculateDistance(userLat, userLng, coords.lat, coords.lon);
    results.push({
      store,
      distanceMeters,
      coordinates: coords
    });
  }
  return results
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

module.exports = {
  calculateDistance,
  extractCoordinatesFromUrl,
  getCoordinatesFromLink,
  findNearestStores
};