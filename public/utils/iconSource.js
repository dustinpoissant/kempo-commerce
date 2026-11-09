/*
  The address of the icon file a page builder icon setting names. The page builder stores an icon as a kempo-ui icon name
  (`shopping_cart`) or as `src:` and the address of an SVG file (`src:/commerce/icons/shopping_cart.svg`); the commerce
  components take the address itself. An address that is already one is kept, and an empty value is no icon. No browser
  imports, so the tests can read it.
*/
export default value => {
  const text = String(value ?? '').trim();
  if(!text) return '';
  if(text.startsWith('src:')) return text.slice(4);
  if(text.startsWith('/')) return text;
  return `/kempo-ui/icons/${text}.svg`;
};
