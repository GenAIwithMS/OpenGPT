import React from 'react';

// The OpenGPT logo (source files and guidelines: logo/README.md).
// Both take the surrounding text colour.

const SYMBOL = 'M52.6 158.9A92 92 0 1 1 104.5 206.5L56 222L116.8 172.6A56 56 0 1 0 85.2 143.7Z';
const WORDMARK = [
  'M87.5 -169.0A362 362 0 1 1 265.4 -14.4L101.0 12.0L321.6 -153.4A212 212 0 1 0 217.4 -244.0Z',
  'M1204.0 8.0C1355.0 8.0 1472.0 -100.0 1472.0 -269.0C1472.0 -438.0 1355.0 -546.0 1204.0 -546.0C1132.0 -546.0 1074.0 -523.0 1035.0 -476.0V-538.0H886.0V194.0H1042.0V-57.0C1082.0 -13.0 1137.0 8.0 1204.0 8.0ZM1177.0 -120.0C1099.0 -120.0 1040.0 -176.0 1040.0 -269.0C1040.0 -362.0 1099.0 -418.0 1177.0 -418.0C1255.0 -418.0 1314.0 -362.0 1314.0 -269.0C1314.0 -176.0 1255.0 -120.0 1177.0 -120.0ZM1836.0 8.0C1933.0 8.0 2008.0 -22.0 2058.0 -79.0L1975.0 -169.0C1938.0 -134.0 1897.0 -117.0 1840.0 -117.0C1758.0 -117.0 1701.0 -158.0 1686.0 -225.0H2093.0C2094.0 -238.0 2096.0 -255.0 2096.0 -267.0C2096.0 -440.0 1974.0 -546.0 1816.0 -546.0C1652.0 -546.0 1529.0 -430.0 1529.0 -269.0C1529.0 -109.0 1650.0 8.0 1836.0 8.0ZM1685.0 -316.0C1696.0 -384.0 1746.0 -428.0 1817.0 -428.0C1887.0 -428.0 1938.0 -384.0 1949.0 -316.0ZM2193.0 0.0H2349.0V-266.0C2349.0 -365.0 2403.0 -411.0 2478.0 -411.0C2547.0 -411.0 2587.0 -371.0 2587.0 -284.0V0.0H2743.0V-308.0C2743.0 -472.0 2647.0 -546.0 2520.0 -546.0C2447.0 -546.0 2384.0 -521.0 2342.0 -474.0V-538.0H2193.0ZM3226.0 12.0C3326.0 12.0 3432.0 -19.0 3509.0 -77.0V-361.0H3361.0V-155.0C3321.0 -134.0 3279.0 -126.0 3235.0 -126.0C3101.0 -126.0 3008.0 -219.0 3008.0 -350.0C3008.0 -483.0 3101.0 -574.0 3237.0 -574.0C3308.0 -574.0 3367.0 -549.0 3418.0 -495.0L3522.0 -591.0C3454.0 -670.0 3352.0 -712.0 3229.0 -712.0C3006.0 -712.0 2844.0 -561.0 2844.0 -350.0C2844.0 -139.0 3006.0 12.0 3226.0 12.0ZM3652.0 0.0H3814.0V-193.0H3955.0C4142.0 -193.0 4259.0 -290.0 4259.0 -446.0C4259.0 -603.0 4142.0 -700.0 3955.0 -700.0H3652.0ZM3814.0 -325.0V-568.0H3946.0C4045.0 -568.0 4095.0 -523.0 4095.0 -446.0C4095.0 -370.0 4045.0 -325.0 3946.0 -325.0ZM4522.0 0.0H4684.0V-568.0H4908.0V-700.0H4298.0V-568.0H4522.0Z',
];

/**
 * The speaking O on its own, for places where the name doesn't fit
 * (collapsed sidebar). Decorative unless `label` is given.
 *
 * @param {object} props
 * @param {number} [props.size=20]
 * @param {string} [props.label]  Accessible name; omit when text beside it says "OpenGPT".
 * @param {string} [props.className]
 */
export const LogoMark = ({ size = 20, label, className = '' }) => (
  <svg viewBox="36 25 200 200" width={size} height={size} fill="currentColor" className={className}
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
    <path d={SYMBOL} />
  </svg>
);

/**
 * "OpenGPT" with the speaking O as its first letter. Height sets the size;
 * below about 20px tall use LogoMark instead.
 *
 * @param {object} props
 * @param {string} [props.className]  Height and colour classes (default h-5).
 */
const Logo = ({ className = 'h-5' }) => (
  <svg viewBox="0 -720 4913 922" fill="currentColor" role="img" aria-label="OpenGPT" className={`w-auto shrink-0 ${className}`}>
    {WORDMARK.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

export default Logo;
