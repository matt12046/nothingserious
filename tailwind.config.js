/** @type {import('tailwindcss').Config} */
module.exports = {
    // Class names used in index.html, including the ones its script adds at runtime
    content: ['./index.html'],
    theme: {
        extend: {
            colors: {
                // Aston Martin lime: text-lime, bg-lime, hover:text-lime, ...
                lime: '#cedc00',
            },
        },
    },
};
