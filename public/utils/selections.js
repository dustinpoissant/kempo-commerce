/*
  The options a product's variation is made of: `{ optionKey: choiceKey }`. The Add to cart widget keeps them as the
  text of its `selections` attribute (JSON), so a page can be made for one variation. No browser imports, so the tests
  read the same code the page runs.
*/
export const parseSelections = text => {
  try {
    const value = JSON.parse(text || '{}');
    if(!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, choice]) => typeof choice === 'string' && choice !== ''));
  } catch {
    return {};
  }
};

export const selectionsText = picked => {
  const entries = Object.entries(picked ?? {}).filter(([, choice]) => choice).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : '';
};

/* The choices of `picked` that the product really has and can sell, so nothing unknown or sold out is sent. */
export const validSelections = (product, picked) => {
  const chosen = {};
  for(const option of product?.options ?? []){
    const key = picked?.[option.key];
    if(option.choices.some(choice => choice.key === key && choice.available)) chosen[option.key] = key;
  }
  return chosen;
};

/* The labels of the required options that have no valid choice yet. */
export const missingRequired = (product, picked) => {
  const chosen = validSelections(product, picked);
  return (product?.options ?? []).filter(option => option.required && !chosen[option.key]).map(option => option.label);
};
