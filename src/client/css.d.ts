/**
 * Type declarations for the bundled stylesheet modules.
 *
 * The build compiles `*.module.css` into an internal module that injects one
 * tagged `<style>` element and exports the class-name mapping, so the only type
 * the TypeScript side needs is that mapping.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
