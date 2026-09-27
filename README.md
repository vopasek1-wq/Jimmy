# Řezací plán trubek

Kalkulačka pro optimalizaci řezání trubek z tyčí 6000 mm s prořezem 3 mm.

Otevři `index.html` v prohlížeči (nic se neinstaluje). Zadej délky kusů a počty,
kalkulačka navrhne rozložení na co nejmenší počet tyčí, seskupí stejné nářezy
a ukáže zbytky.

- Prořez se počítá mezi jednotlivými kusy (za posledním kusem ne), stejně jako
  v ručně kresleném plánu.
- Plán hledá heuristika (knapsack + First Fit Decreasing) a u menších zadání
  ho přesné prohledávání ověří jako optimum.
- Tyč je pevně 6000 mm a prořez 3 mm, materiál ocel/hliník. Kalkulačka startuje prázdná, zadání se pamatuje v prohlížeči.
