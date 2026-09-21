/* 

<select class="custom-select">
  <option value="0">1 Token Black</option>
  <option value="1">1 Token Clear</option>
</select> 
*/

const variantMap = {
  '50581158134073': {
    'sku': 'BH-T1-BLACK-L20',
    'optionIndex': 0
  },
  '50157011140921': {
    'sku': 'BH-T1-CLEAR-L20',
    'optionIndex': 1
  },
  '50581158166841': {
    'sku': 'BH-T2-BLACK-L20',
    'optionIndex': 2
  },
  '50581158068537': {
    'sku': 'BH-T2-CLEAR-L20',
    'optionIndex': 3
  },
  '50581158199609': {
    'sku': 'BH-T3-BLACK-L20',
    'optionIndex': 4
  },
  '50581158101305': {
    'sku': 'BH-T3-CLEAR-L20',
    'optionIndex': 5
  }
};

function parseQueryString() {
  const params = {};
  const queryString = window.location.search.substring(1); // removes '?' from start
  const pairs = queryString.split('&').filter(Boolean); // split into pairs, filter empty strings

  pairs.forEach(pair => {
    const [key, value] = pair.split('=').map(decodeURIComponent);
    params[key] = value;
  });

  return params;
}

// Automatically select the option based on "variant" query parameter
function selectVariantBasedOnQueryString() {
  const params = parseQueryString();
  const variant = params['variant'];
  var select = document.querySelector('select.custom-select');
  if (select && variantMap[variant]) {
    let optionIndex = variantMap[variant].optionIndex;
    select.value = optionIndex;
    // Explicitly trigger the 'change' event (optional, but recommended)
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.options[optionIndex].click();
    // Hide the parent div of the select element
    select.parentElement.style.display = 'none';
  }
}

function delayedVariantTrigger(delayMS){
  setTimeout(selectVariantBasedOnQueryString, delayMS);
}

function changeSliderColor(){
  var slider = document.querySelector('.image-uploader-slider');
  if (slider) {
    slider.min = '0.1';
    slider.max = '4';
    slider.step = '0.01';
  }
}

// function delayedUploadButtonCheck(){
//   const uploadButton = document.querySelector('.upload-button');
//   if (uploadButton){
//     uploadButton.addEventListener('mousedown', delayedSliderChange);
//   }
// }
function delayedSliderChange(){
  setTimeout(changeSliderColor, 5000);
}

// Check if the element is actually visible
function isElementVisible(el) {
  return el.offsetParent !== null && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
}

// Run code on page load
document.addEventListener('DOMContentLoaded', () => {
  delayedVariantTrigger(1500);
  // setTimeout(delayedUploadButtonCheck, 5000);



  // Set up the ImageUploaderModal observer
  const observer = new MutationObserver((mutationsList, observer) => {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList' && mutation.addedNodes.length) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1 && node.id === 'ImageUploaderModal' && isElementVisible(node)) {
            changeSliderColor();
          }
        });
      }
  
      // Also handle attribute changes to catch visibility toggling
      if (mutation.type === 'attributes' && mutation.target.id === 'ImageUploaderModal') {
        if (isElementVisible(mutation.target)) {
          changeSliderColor();
        }
      }
    }
  });
  
  // Start observing the document body for both child and attribute changes
  observer.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'aria-hidden'] 
  });




  // Attach listeners to all input elements within your <variant-selects> element
  const variantSelects = document.getElementById('variant-selects-template--22627086958905__main');

  if (variantSelects) {
    variantSelects.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener('change', delayedVariantTrigger, 100);
      input.addEventListener('click', delayedVariantTrigger, 100);
    });
  }
});