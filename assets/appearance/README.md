# Appearance assets

The SVG files come from the approved Touchline appearance component, Figma node `40:317` in file `dHJwW62Wb4nxGvDIuQn7EE`.
The bundled CSS embeds the original SVG bytes and preserves their natural dimensions.

Syne and IBM Plex Sans come from the local Projection UI documentation font package.
Their SIL Open Font License texts are included beside the font files.
The CSS uses scoped font-family aliases for the appearance panel.
Other screens retain their existing typography.

`appearance.css` embeds the SVGs as data URLs.
The local hub serves the two font files through explicit asset routes.
The appearance panel makes no external requests.
