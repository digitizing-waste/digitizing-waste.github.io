const HEAVY_KEYWORDS = [
  'drilling mud', 'wastewater', 'sludge', 'drilling waste',
  'crude oil residues', 'wastewater pools', 'excavated soil',
  'rock cuttings', 'displaced earth', 'excavated earth',
  'compacted sand',
];

const LIGHT_KEYWORDS = [
  'crude oil', 'flames', 'black smoke', 'fire', 'welding fumes',
  'dust cloud', 'smoke',
];

function intersectCount(aArr, bArr) {
  if (!aArr.length || !bArr.length) return 0;
  const setB = new Set(bArr.map(s => s.toLowerCase()));
  return aArr.reduce((n, s) => n + (setB.has(s.toLowerCase()) ? 1 : 0), 0);
}

/**
 * Returns all images sorted descending by affinity score relative to `seed`.
 * Score = substances_and_residues × 3  +  ecology_and_landscape × 2
 *       + equipment_and_infrastructure × 2
 */
export function computeAffinityScores(seed, images) {
  return images
    .filter(img => img.image_path !== seed.image_path)
    .map(img => ({
      source: seed.image_path,
      target: img.image_path,
      score:
        intersectCount(seed.substances_and_residues,      img.substances_and_residues)      * 3 +
        intersectCount(seed.ecology_and_landscape,        img.ecology_and_landscape)        * 2 +
        intersectCount(seed.equipment_and_infrastructure, img.equipment_and_infrastructure) * 2,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Returns { heavy, light } keyword match counts for a single image. */
export function classifyNode(image) {
  const subs = image.substances_and_residues.map(s => s.toLowerCase());
  const heavy = HEAVY_KEYWORDS.reduce(
    (n, k) => n + (subs.some(s => s.includes(k)) ? 1 : 0), 0
  );
  const light = LIGHT_KEYWORDS.reduce(
    (n, k) => n + (subs.some(s => s.includes(k)) ? 1 : 0), 0
  );
  return { heavy, light };
}

/**
 * Returns a bias value in [-1, 1].
 * Positive  → heavy substances (sinks to canvas bottom).
 * Negative  → volatile substances (floats to canvas top).
 * Zero      → neutral / no classifiable substances.
 */
export function getVerticalBias(image) {
  const { heavy, light } = classifyNode(image);
  const total = heavy + light;
  if (total === 0) return 0;
  return (heavy - light) / total;
}

/** Returns 'subsurface' or 'surface' based on extractive phase. */
export function getPhaseZone(extractive_phase) {
  if (
    extractive_phase === 'Drilling & Well Creation' ||
    extractive_phase === 'Topographic/Seismic Exploration'
  ) {
    return 'subsurface';
  }
  return 'surface';
}
