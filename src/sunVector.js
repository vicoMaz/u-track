/** Returns a unit ECI vector pointing from Earth toward the Sun at `date`. */
export function sunDirectionECI(date) {
  const daysSinceJ2000 = (date - new Date('2000-01-01T12:00:00Z')) / 86400000;
  const L = (280.46 + 0.9856474 * daysSinceJ2000) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * daysSinceJ2000) * Math.PI / 180;
  const lambda = L + 1.915 * Math.sin(g) * Math.PI / 180;
  const epsilon = 23.439 * Math.PI / 180;
  return {
    x: Math.cos(lambda),
    y: Math.cos(epsilon) * Math.sin(lambda),
    z: Math.sin(epsilon) * Math.sin(lambda),
  };
}
