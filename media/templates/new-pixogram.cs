// ---
// app: MyPixogramName
// displayName: Human Readable Name
// appType: ClockFace
// author: Your Name
// description: Brief description of what this pixogram does
// ---

#:package Pxl@0.0.59

using Pxl.Ui.CSharp;

// State variables go here (persist between frames)
var count = 0;

// We always need to return a DrawingContext delegate that contains our drawing code.
// This is what gets called every frame to render the pixogram.
// There always has to be exactly one 'scene' delegate with this signature.
var scene = (DrawingContext ctx) =>
{
    // Drawing code here — runs every frame

    ctx.DrawBackground(Colors.Blue);

    ctx.DrawTextMono4x5(
        $"Count: {count}",
        color: Colors.White,
        x: 10,
        y: 10);
    count++;
};
