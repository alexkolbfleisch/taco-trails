import { Component, ElementRef, HostListener, signal, inject } from '@angular/core';

@Component({
    selector: 'app-split-view',
    standalone: true,
    templateUrl: './split-view.component.html',
    styleUrl: './split-view.component.css',
})
export class SplitViewComponent {
    private el = inject(ElementRef);
    leftPanelFlex = signal<number>(50);
    isDragging = false;
    private isHorizontal = true;

    startDrag(event: MouseEvent) {
        this.isDragging = true;
        event.preventDefault();
        this.isHorizontal = window.innerWidth > 900;
    }

    @HostListener('window:mousemove', ['$event'])
    onDrag(event: MouseEvent) {
        if (!this.isDragging) return;

        const containerRect = this.el.nativeElement.querySelector('.split-view-layout').getBoundingClientRect();

        let newFlex: number;
        if (this.isHorizontal) {
            newFlex = ((event.clientX - containerRect.left) / containerRect.width) * 100;
        } else {
            newFlex = ((event.clientY - containerRect.top) / containerRect.height) * 100;
        }

        if (newFlex < 10) newFlex = 10;
        if (newFlex > 90) newFlex = 90;

        this.leftPanelFlex.set(newFlex);
    }

    @HostListener('window:mouseup')
    stopDrag() {
        this.isDragging = false;
    }
}
