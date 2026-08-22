// The SecurEra shield mark, served from /public/brand. Used everywhere the
// product identifies itself with the default (non-white-labelled) brand.
// Tenants that upload their own logo still get theirs — see branding.js.
// Pass `white` on dark surfaces (e.g. the login brand panel).

export default function BrandMark({ size = 30, alt = 'SecurEra', className = '', white = false }) {
  return (
    <img
      src={white ? "/brand/securera-mark-white.svg" : "/brand/securera-mark.svg"}
      alt={alt}
      width={size}
      height={size}
      className={`brand-mark ${className}`.trim()}
      style={{ display: 'block', flex: 'none', objectFit: 'contain' }}
    />
  );
}
