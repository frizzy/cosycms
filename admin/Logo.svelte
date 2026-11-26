<script lang="ts">
  import "@fontsource/ibm-plex-mono/latin-600.css";
  let { size = 24 }: { size?: number } = $props(); // a multiple of 8 keeps every pixel of the mug on whole screen pixels
</script>
<span class="logo"><svg viewBox="0 0 8 8" width={size} height={size} shape-rendering="crispEdges" aria-hidden="true"><path fill="#EDF171" d="M2 0h1v1H2zM4 0h1v1H4zM1 3h4v1H1z" /><path fill="#C46C71" d="M1 2h4v1H1z" /><path fill="#A9FF9F" d="M1 4h4v1H1z" /><path fill="#75CEC8" d="M1 5h4v1H1z" /><path fill="#706DEB" d="M1 6h4v1H1zM5 3h2v1H5zM6 4h1v1H6zM5 5h2v1H5z" /><path fill="#8E3C97" d="M1 7h4v1H1z" /></svg>cosyCMS</span>
